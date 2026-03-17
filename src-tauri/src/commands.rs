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
    let dir = dirs::document_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
        .join("MötesSkribent");
    let _ = std::fs::create_dir_all(&dir);
    dir.to_string_lossy().to_string()
}

#[tauri::command]
pub async fn write_text_to_file(content: String, destination: String) -> Result<(), String> {
    tokio::fs::write(&destination, content.as_bytes())
        .await
        .map_err(|e| format!("Kunde inte spara filen: {}", e))
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
    // 1. Check MOTESSKRIBENT_PYTHON env var (explicit override)
    if let Ok(p) = std::env::var("MOTESSKRIBENT_PYTHON") {
        return Ok(p);
    }

    // 2. Check for venv relative to CWD and parent dir (dev mode)
    //    When running `cargo tauri dev` CWD is src-tauri/, so we also
    //    check the parent directory (project root) for the venv.
    let cwd = std::env::current_dir().unwrap_or_default();
    let parent = cwd.parent().map(|p| p.to_path_buf()).unwrap_or(cwd.clone());

    let venv_candidates = [
        // CWD (when running from project root)
        cwd.join("DevMotesskribent.venv").join("Scripts").join("python.exe"),
        cwd.join(".venv").join("Scripts").join("python.exe"),
        // Parent (when CWD is src-tauri/)
        parent.join("DevMotesskribent.venv").join("Scripts").join("python.exe"),
        parent.join(".venv").join("Scripts").join("python.exe"),
    ];

    for p in &venv_candidates {
        if p.exists() {
            return Ok(p.to_string_lossy().to_string());
        }
    }

    // 3. Fall back to system python
    Ok("python".to_string())
}
