use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptionConfig {
    pub model: String,
    pub num_speakers: Option<u32>,
    pub formats: Vec<String>,
    pub output_dir: String,
    pub vad_enabled: bool,
    pub prompt: Option<String>,
    pub speed_profile: Option<String>,
    pub audio_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PipelineEvent {
    #[serde(rename = "progress")]
    Progress {
        stage: String,
        percent: u32,
        message: String,
    },
    #[serde(rename = "result")]
    Result {
        success: bool,
        output_files: Vec<String>,
        summary: serde_json::Value,
        #[serde(default)]
        md_content: Option<String>,
        #[serde(default)]
        warnings: Vec<String>,
        #[serde(default)]
        model_name: Option<String>,
        #[serde(default)]
        segments: Option<Vec<serde_json::Value>>,
        #[serde(default)]
        word_count: Option<u32>,
    },
    #[serde(rename = "error")]
    Error { message: String, stage: String },
}

pub async fn run_python_pipeline(
    app: AppHandle,
    audio_path: PathBuf,
    config: TranscriptionConfig,
    python_path: String,
) -> Result<(), String> {
    let mut cmd = Command::new(&python_path);
    cmd.arg("-m")
        .arg("motesskribent")
        .arg("transkribera")
        .arg(audio_path.to_string_lossy().to_string())
        .arg("--json-ipc")
        .arg("--modell")
        .arg(&config.model)
        .arg("--output")
        .arg(&config.output_dir);

    if let Some(n) = config.num_speakers {
        cmd.arg("--talare").arg(n.to_string());
    }

    for fmt in &config.formats {
        cmd.arg("--format").arg(fmt);
    }

    if !config.vad_enabled {
        cmd.arg("--no-vad");
    }

    if let Some(ref prompt) = config.prompt {
        cmd.arg("--prompt").arg(prompt);
    }

    if let Some(ref profile) = config.speed_profile {
        cmd.arg("--speed-profile").arg(profile);
    }

    // Force Python to use UTF-8 for stdout/stderr (avoids cp1252 on Windows)
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Prevent console window on Windows
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let mut child = cmd.spawn().map_err(|e| format!("Kunde inte starta Python: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Kunde inte läsa stdout från Python-processen")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Kunde inte läsa stderr från Python-processen")?;

    let mut reader = BufReader::new(stdout);
    let mut last_error_message: Option<String> = None;

    // Read raw bytes to handle non-UTF-8 output (e.g. Windows cp1252 from Python)
    loop {
        let mut buf = Vec::new();
        let bytes_read = reader
            .read_until(b'\n', &mut buf)
            .await
            .map_err(|e| format!("IO-fel: {}", e))?;
        if bytes_read == 0 {
            break;
        }
        let line = String::from_utf8_lossy(&buf).trim().to_string();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<PipelineEvent>(&line) {
            Ok(event) => {
                if let PipelineEvent::Error { ref message, .. } = event {
                    last_error_message = Some(message.clone());
                }
                let _ = app.emit("pipeline-event", &event);
            }
            Err(_) => {
                // Non-JSON output (e.g. logging), ignore
            }
        }
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("Väntefel: {}", e))?;

    if !status.success() {
        // Read stderr for diagnostics (lossy to handle non-UTF-8 Windows output)
        let mut stderr_reader = BufReader::new(stderr);
        let mut stderr_buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut stderr_reader, &mut stderr_buf).await;
        let stderr_trimmed = String::from_utf8_lossy(&stderr_buf).trim().to_string();

        if let Some(ref err_msg) = last_error_message {
            // We already emitted the real error via pipeline-event, don't emit a generic one.
            // Return the real error message to the invoke caller.
            return Err(err_msg.clone());
        }

        // No JSON error was received — build message from stderr or exit code
        let error_msg = if !stderr_trimmed.is_empty() {
            format!("Python-fel: {}", stderr_trimmed)
        } else {
            format!("Python-processen avslutades med kod {}", status)
        };

        let _ = app.emit(
            "pipeline-event",
            &PipelineEvent::Error {
                message: error_msg.clone(),
                stage: "pipeline".to_string(),
            },
        );
        return Err(error_msg);
    }

    Ok(())
}
