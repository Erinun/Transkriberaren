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
        percent: i32,
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
    cmd.env("PYTHONUNBUFFERED", "1");
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Test att PipelineEvent::Progress kan deserialiseras från JSON
    /// med extra `request_id`-fält (som server.py skickar).
    #[test]
    fn test_progress_with_request_id() {
        let json = serde_json::json!({
            "request_id": "abc-123",
            "type": "progress",
            "stage": "transcription",
            "percent": 45,
            "message": "Transkriberar (segment 10/~50)"
        });

        let result = serde_json::from_value::<PipelineEvent>(json);
        assert!(result.is_ok(), "Deserialisering misslyckades: {:?}", result.err());
    }

    /// Test att heartbeat-events deserialiseras korrekt.
    #[test]
    fn test_heartbeat_with_request_id() {
        let json = serde_json::json!({
            "request_id": "abc-123",
            "type": "progress",
            "stage": "heartbeat",
            "percent": -1,
            "message": "Pipeline aktiv"
        });

        let result = serde_json::from_value::<PipelineEvent>(json);
        assert!(result.is_ok(), "Heartbeat deserialisering misslyckades: {:?}", result.err());
    }

    /// Test progress UTAN request_id (one-shot mode via cli.py).
    #[test]
    fn test_progress_without_request_id() {
        let json = serde_json::json!({
            "type": "progress",
            "stage": "preprocessing",
            "percent": 5,
            "message": "Förbehandlar ljud"
        });

        let result = serde_json::from_value::<PipelineEvent>(json);
        assert!(result.is_ok(), "Deserialisering utan request_id misslyckades: {:?}", result.err());
    }

    /// Test result-event med request_id och alla fält.
    #[test]
    fn test_result_with_request_id() {
        let json = serde_json::json!({
            "request_id": "abc-123",
            "type": "result",
            "success": true,
            "output_files": ["/path/to/file.md"],
            "summary": {"total_duration": 120.0, "speech_duration": 100.0, "processing_time": 60.0, "num_speakers": 2, "num_segments": 10},
            "md_content": "# Möte",
            "warnings": [],
            "model_name": "KBLab/kb-whisper-base",
            "segments": [{"start": 0.0, "end": 5.0, "speaker_id": "s1", "speaker_label": "Talare 1", "text": "Hej"}],
            "word_count": 50
        });

        let result = serde_json::from_value::<PipelineEvent>(json);
        assert!(result.is_ok(), "Result deserialisering misslyckades: {:?}", result.err());
    }

    /// Test error-event med request_id.
    #[test]
    fn test_error_with_request_id() {
        let json = serde_json::json!({
            "request_id": "abc-123",
            "type": "error",
            "message": "Modellen hittades inte",
            "stage": "transcription"
        });

        let result = serde_json::from_value::<PipelineEvent>(json);
        assert!(result.is_ok(), "Error deserialisering misslyckades: {:?}", result.err());
    }

    /// Test from_str (som one-shot sidecar.rs använder) vs from_value (som sidecar_manager.rs använder).
    #[test]
    fn test_from_str_with_request_id() {
        let json_str = r#"{"request_id":"abc-123","type":"progress","stage":"heartbeat","percent":-1,"message":"Pipeline aktiv"}"#;

        let result = serde_json::from_str::<PipelineEvent>(json_str);
        assert!(result.is_ok(), "from_str misslyckades: {:?}", result.err());
    }
}
