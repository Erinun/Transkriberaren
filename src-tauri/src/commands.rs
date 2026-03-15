use crate::audio_capture::RecorderState;
use crate::sidecar::{run_python_pipeline, TranscriptionConfig};
use crate::sidecar_manager::SidecarManager;
use std::path::PathBuf;
use tauri::{AppHandle, State};

#[tauri::command]
pub async fn run_transcription(
    app: AppHandle,
    audio_path: String,
    config: TranscriptionConfig,
    sidecar: State<'_, SidecarManager>,
) -> Result<(), String> {
    let audio = PathBuf::from(&audio_path);
    if !audio.exists() {
        return Err(format!("Filen finns inte: {}", audio_path));
    }

    // Try persistent sidecar first, fall back to one-shot
    let result = sidecar.transcribe(&app, audio.clone(), config.clone()).await;

    if let Err(ref e) = result {
        log::warn!("Persistent sidecar misslyckades ({}), försöker one-shot", e);
        let python_path = find_python(&app)?;
        run_python_pipeline(app, audio.clone(), config, python_path).await?;
    } else {
        result?;
    }

    // Clean up temp file if it was a recording
    let temp_dir = std::env::temp_dir();
    if audio.starts_with(&temp_dir) {
        if let Some(name) = audio.file_name().and_then(|n| n.to_str()) {
            if name.starts_with("motesskribent_rec_") {
                let _ = std::fs::remove_file(&audio);
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_file(path: String) -> Result<(), String> {
    opener::open(&path).map_err(|e| format!("Kunde inte öppna filen: {}", e))
}

#[tauri::command]
pub fn get_default_output_dir() -> String {
    let dir = std::env::current_dir()
        .unwrap_or_default()
        .join("output");
    dir.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn start_recording(
    state: State<'_, RecorderState>,
    app: AppHandle,
) -> Result<(), String> {
    crate::audio_capture::start_recording(&state, app)
}

#[tauri::command]
pub async fn stop_recording(
    state: State<'_, RecorderState>,
) -> Result<String, String> {
    crate::audio_capture::stop_recording(&state)
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Kunde inte läsa filen: {}", e))
}

#[tauri::command]
pub async fn copy_file_to(source: String, destination: String) -> Result<(), String> {
    tokio::fs::copy(&source, &destination)
        .await
        .map(|_| ())
        .map_err(|e| format!("Kunde inte spara filen: {}", e))
}

pub fn find_python(_app: &AppHandle) -> Result<String, String> {
    // 1. Check for venv relative to the app resource dir or CWD
    let cwd = std::env::current_dir().unwrap_or_default();

    let venv_candidates = [
        cwd.join("DevMotesskribent.venv").join("Scripts").join("python.exe"),
        cwd.join(".venv").join("Scripts").join("python.exe"),
    ];

    for p in &venv_candidates {
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }

    // 2. Check MOTESSKRIBENT_PYTHON env var
    if let Ok(p) = std::env::var("MOTESSKRIBENT_PYTHON") {
        return Ok(p);
    }

    // 3. Fall back to system python
    Ok("python".to_string())
}
