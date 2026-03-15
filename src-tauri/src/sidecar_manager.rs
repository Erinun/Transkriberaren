use crate::sidecar::{PipelineEvent, TranscriptionConfig};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
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
        let python = self.get_python(app)?;
        let proc = self.spawn_process(&python, app).await?;
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

    async fn spawn_process(
        &self,
        python: &str,
        app: &AppHandle,
    ) -> Result<SidecarProcess, String> {
        let mut cmd = Command::new(python);
        cmd.arg("-m")
            .arg("motesskribent")
            .arg("serve");

        cmd.env("PYTHONIOENCODING", "utf-8");
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

        // Spawn background reader that routes events by request_id
        let pending = self.pending.clone();
        let app_clone = app.clone();
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

                        let req_id = parsed
                            .get("request_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let msg_type = parsed
                            .get("type")
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
        });

        // Wait for the "ready" message
        let ready_timeout = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            async {
                // The ready message has no request_id, it was already consumed by the reader above.
                // We just wait a brief moment for it to arrive.
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            },
        )
        .await;

        if ready_timeout.is_err() {
            return Err("Timeout vid start av Python-sidecar".to_string());
        }

        Ok(SidecarProcess { child, stdin })
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

        // Wait for "end" sentinel with timeout (10 min for long transcriptions)
        let wait_result = tokio::time::timeout(
            std::time::Duration::from_secs(600),
            done.notified(),
        )
        .await;

        // Collect events and clean up
        let events = {
            let mut map = self.pending.lock().await;
            map.remove(&req_id)
                .map(|e| e.events)
                .unwrap_or_default()
        };

        if wait_result.is_err() {
            return Err("Timeout: sidecar svarade inte inom 10 minuter".to_string());
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
            }
        });

        self.send_command(cmd, app).await?;
        Ok(())
    }

    /// Warm up models in the sidecar.
    pub async fn warmup(&self, app: &AppHandle) -> Result<(), String> {
        let req_id = Uuid::new_v4().to_string();

        let cmd = serde_json::json!({
            "request_id": req_id,
            "command": "warmup",
            "config": {
                "model": "KBLab/kb-whisper-small",
                "num_speakers": null
            }
        });

        self.send_command(cmd, app).await?;
        Ok(())
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
