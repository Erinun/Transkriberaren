use crate::sidecar::{PipelineEvent, TranscriptionConfig};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

/// A pending request waiting for its "end" sentinel.
struct PendingRequest {
    /// Collects all events for this request (progress, result, error).
    events: Vec<Value>,
    /// Notified when the "end" sentinel arrives.
    done: Arc<Notify>,
}

/// Manages a persistent Python sidecar process.
pub struct SidecarManager {
    /// The child process handle + stdin writer. None if not started or crashed.
    inner: Mutex<Option<SidecarProcess>>,
    /// Pending requests keyed by request_id.
    pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    /// Serialize transcription commands (one at a time).
    transcribe_lock: Mutex<()>,
    /// The Python executable path.
    python_path: Mutex<Option<String>>,
}

struct SidecarProcess {
    child: Child,
    stdin: tokio::process::ChildStdin,
    /// Signaled when the background reader hits EOF (process died).
    disconnected: Arc<Notify>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            transcribe_lock: Mutex::new(()),
            python_path: Mutex::new(None),
        }
    }

    /// Set the Python path to use for spawning the sidecar.
    pub async fn set_python_path(&self, path: String) {
        *self.python_path.lock().await = Some(path);
    }

    /// Ensure the sidecar process is running. Returns Ok if ready.
    async fn ensure_running(&self, app: &AppHandle) -> Result<(), String> {
        let mut guard = self.inner.lock().await;
        if let Some(ref mut proc) = *guard {
            // Check if still alive
            match proc.child.try_wait() {
                Ok(Some(_status)) => {
                    // Process exited, need to restart
                    *guard = None;
                }
                Ok(None) => return Ok(()), // still running
                Err(_) => {
                    *guard = None;
                }
            }
        }

        // Need to spawn
        let proc = self.spawn_process(app).await?;
        *guard = Some(proc);
        Ok(())
    }

    fn get_python(&self, app: &AppHandle) -> Result<String, String> {
        // Try cached path first (blocking check since we're already in async)
        if let Ok(guard) = self.python_path.try_lock() {
            if let Some(ref p) = *guard {
                return Ok(p.clone());
            }
        }
        // Fall back to find_python logic
        crate::commands::find_python(app)
    }

    /// Find the bundled sidecar exe in the Tauri resource directory.
    fn find_bundled_sidecar(app: &AppHandle) -> Option<PathBuf> {
        let resource_dir = app.path().resource_dir().ok()?;
        let exe = resource_dir
            .join("sidecar")
            .join("motesskribent-sidecar.exe");
        if exe.exists() {
            Some(exe)
        } else {
            None
        }
    }

    async fn spawn_process(
        &self,
        app: &AppHandle,
    ) -> Result<SidecarProcess, String> {
        // Production: use bundled sidecar exe if present
        // Dev (debug builds): always use Python source so code changes take effect
        let use_bundled = if cfg!(debug_assertions) {
            log::info!("Debug-läge: hoppar över bundlad sidecar, använder Python-källa");
            None
        } else {
            Self::find_bundled_sidecar(app)
        };

        let mut cmd = if let Some(ref exe) = use_bundled {
            log::info!("Använder bundlad sidecar: {}", exe.display());
            Command::new(exe)
        } else {
            let python = self.get_python(app)?;
            log::info!("Använder Python: {}", python);
            let mut c = Command::new(&python);
            c.arg("-m").arg("motesskribent").arg("serve");
            c
        };

        cmd.env("PYTHONIOENCODING", "utf-8");

        // Belt-and-suspenders: set HF env vars from Rust side for bundled exe.
        // Redundant with sidecar_entry.py but protects against cases where
        // sys.executable resolves differently.
        if let Some(ref exe) = use_bundled {
            let models_dir = exe.parent().unwrap().join("models");
            if models_dir.is_dir() {
                log::info!("Sätter HF env vars: models_dir={}", models_dir.display());
                cmd.env("HF_HOME", &models_dir);
                cmd.env("HF_HUB_CACHE", models_dir.join("hub"));
                cmd.env("HF_HUB_OFFLINE", "1");
            }
        }

        cmd.stdin(std::process::Stdio::piped());
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Kunde inte starta Python-sidecar: {}", e))?;

        let stdin = child
            .stdin
            .take()
            .ok_or("Kunde inte öppna stdin för sidecar")?;

        let stdout = child
            .stdout
            .take()
            .ok_or("Kunde inte öppna stdout för sidecar")?;

        let disconnected = Arc::new(Notify::new());
        let ready_signal = Arc::new(Notify::new());

        // Spawn background reader that routes events by request_id
        let pending = self.pending.clone();
        let app_clone = app.clone();
        let dc = disconnected.clone();
        let rs = ready_signal.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut buf = Vec::new();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break, // EOF — process exited
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf).trim().to_string();
                        if line.is_empty() {
                            continue;
                        }
                        let parsed: Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(_) => continue, // non-JSON output (logging etc.)
                        };

                        let msg_type = parsed
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        // Signal ready when Python sends {"type": "ready"}
                        if msg_type == "ready" {
                            rs.notify_one();
                            continue;
                        }

                        let req_id = parsed
                            .get("request_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        // Emit pipeline-event for progress/result/error (so frontend gets updates)
                        if msg_type == "progress" || msg_type == "result" || msg_type == "error" {
                            if let Ok(event) = serde_json::from_value::<PipelineEvent>(parsed.clone()) {
                                let _ = app_clone.emit("pipeline-event", &event);
                            }
                        }

                        let mut map = pending.lock().await;
                        if let Some(entry) = map.get_mut(&req_id) {
                            if msg_type == "end" {
                                entry.done.notify_one();
                            } else {
                                entry.events.push(parsed);
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            // EOF reached — process died or closed stdout
            log::warn!("Sidecar stdout EOF — processen har avslutats");
            dc.notify_waiters();
            // Also wake all pending requests so they don't hang forever
            let map = pending.lock().await;
            for entry in map.values() {
                entry.done.notify_one();
            }
        });

        // Wait for the "ready" message with proper detection of process death
        let dc_clone = disconnected.clone();
        let ready_result = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            async {
                tokio::select! {
                    _ = ready_signal.notified() => Ok(()),
                    _ = dc_clone.notified() => Err("Sidecar-processen avslutades oväntat vid uppstart".to_string()),
                }
            },
        )
        .await;

        match ready_result {
            Err(_) => {
                return Err("Timeout (30s): Python-sidecar skickade aldrig 'ready'".to_string());
            }
            Ok(Err(e)) => {
                return Err(e);
            }
            Ok(Ok(())) => {
                log::info!("Sidecar redo");
            }
        }

        Ok(SidecarProcess { child, stdin, disconnected })
    }

    /// Send a JSON command and wait for the "end" sentinel.
    async fn send_command(&self, cmd: Value, app: &AppHandle) -> Result<Vec<Value>, String> {
        self.ensure_running(app).await?;

        let req_id = cmd
            .get("request_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let done = Arc::new(Notify::new());

        // Get the disconnected signal for the current process
        let disconnected = {
            let guard = self.inner.lock().await;
            guard
                .as_ref()
                .map(|p| p.disconnected.clone())
                .ok_or("Sidecar-process ej startad")?
        };

        // Register pending request
        {
            let mut map = self.pending.lock().await;
            map.insert(
                req_id.clone(),
                PendingRequest {
                    events: Vec::new(),
                    done: done.clone(),
                },
            );
        }

        // Write command to stdin
        {
            let mut guard = self.inner.lock().await;
            if let Some(ref mut proc) = *guard {
                let mut line = serde_json::to_string(&cmd).map_err(|e| e.to_string())?;
                line.push('\n');
                proc.stdin
                    .write_all(line.as_bytes())
                    .await
                    .map_err(|e| format!("Kunde inte skicka till sidecar: {}", e))?;
                proc.stdin
                    .flush()
                    .await
                    .map_err(|e| format!("Flush-fel: {}", e))?;
            } else {
                // Clean up pending
                self.pending.lock().await.remove(&req_id);
                return Err("Sidecar-process ej startad".to_string());
            }
        }

        // Wait for "end" sentinel, process death, or timeout (2h for long transcriptions)
        let process_died = {
            let dc = disconnected.clone();
            let d = done.clone();
            tokio::time::timeout(
                std::time::Duration::from_secs(7200),
                async {
                    tokio::select! {
                        _ = d.notified() => false,
                        _ = dc.notified() => true,
                    }
                },
            )
            .await
        };

        // Collect events and clean up
        let events = {
            let mut map = self.pending.lock().await;
            map.remove(&req_id)
                .map(|e| e.events)
                .unwrap_or_default()
        };

        match process_died {
            Err(_) => {
                return Err("Timeout: sidecar svarade inte inom 2 timmar".to_string());
            }
            Ok(true) => {
                // Process died — check if we got error events before dying
                for ev in &events {
                    if ev.get("type").and_then(|v| v.as_str()) == Some("error") {
                        let msg = ev
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Okänt fel")
                            .to_string();
                        return Err(msg);
                    }
                }
                // Clear the dead process so next call will respawn
                *self.inner.lock().await = None;
                return Err("Sidecar-processen avslutades oväntat".to_string());
            }
            Ok(false) => {
                // Normal completion — check for error events
            }
        }

        // Check if there was an error event (last one wins)
        for ev in &events {
            if ev.get("type").and_then(|v| v.as_str()) == Some("error") {
                let msg = ev
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Okänt fel")
                    .to_string();
                return Err(msg);
            }
        }

        Ok(events)
    }

    /// Run a transcription via the persistent sidecar.
    pub async fn transcribe(
        &self,
        app: &AppHandle,
        audio_path: PathBuf,
        config: TranscriptionConfig,
    ) -> Result<(), String> {
        // Serialize transcription commands
        let _lock = self.transcribe_lock.lock().await;

        let req_id = Uuid::new_v4().to_string();

        let cmd = serde_json::json!({
            "request_id": req_id,
            "command": "transcribe",
            "audio_path": audio_path.to_string_lossy(),
            "config": {
                "model": config.model,
                "num_speakers": config.num_speakers,
                "formats": config.formats,
                "output_dir": config.output_dir,
                "vad_enabled": config.vad_enabled,
                "prompt": config.prompt,
                "speed_profile": config.speed_profile,
            }
        });

        self.send_command(cmd, app).await?;
        Ok(())
    }

    /// Warm up models in the sidecar. Returns whether diarization is available.
    pub async fn warmup(&self, app: &AppHandle) -> Result<bool, String> {
        let req_id = Uuid::new_v4().to_string();

        let cmd = serde_json::json!({
            "request_id": req_id,
            "command": "warmup",
            "config": {
                "model": "KBLab/kb-whisper-small",
                "num_speakers": null
            }
        });

        let events = self.send_command(cmd, app).await?;

        let diarization_available = events.iter().any(|ev| {
            ev.get("diarization_available")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        });

        Ok(diarization_available)
    }

    /// Shut down the sidecar process gracefully.
    pub async fn shutdown(&self) {
        let mut guard = self.inner.lock().await;
        if let Some(ref mut proc) = *guard {
            // Try graceful shutdown
            let shutdown_cmd = serde_json::json!({
                "request_id": Uuid::new_v4().to_string(),
                "command": "shutdown"
            });
            if let Ok(mut line) = serde_json::to_string(&shutdown_cmd) {
                line.push('\n');
                let _ = proc.stdin.write_all(line.as_bytes()).await;
                let _ = proc.stdin.flush().await;
            }

            // Wait up to 5 seconds for graceful exit
            let wait_result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                proc.child.wait(),
            )
            .await;

            if wait_result.is_err() {
                // Force kill
                let _ = proc.child.kill().await;
            }
        }
        *guard = None;
    }
}
