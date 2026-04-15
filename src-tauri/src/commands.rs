use crate::audio_capture::{self, AudioDevice, RecorderState, RecordingResult};
use crate::meeting_detector::MeetingDetector;
use crate::ollama::CancellationMap;
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
pub fn list_audio_devices() -> Vec<AudioDevice> {
    audio_capture::list_audio_devices()
}

#[tauri::command]
pub async fn start_recording(
    state: State<'_, RecorderState>,
    app: AppHandle,
    device_id: Option<String>,
) -> Result<String, String> {
    audio_capture::start_recording(&state, app, device_id)
}

#[tauri::command]
pub async fn stop_recording(
    state: State<'_, RecorderState>,
) -> Result<RecordingResult, String> {
    audio_capture::stop_recording(&state)
}

#[tauri::command]
pub async fn pause_recording(
    state: State<'_, RecorderState>,
) -> Result<(), String> {
    audio_capture::pause_recording(&state)
}

#[tauri::command]
pub async fn resume_recording(
    state: State<'_, RecorderState>,
) -> Result<(), String> {
    audio_capture::resume_recording(&state)
}

#[derive(serde::Serialize)]
pub struct RecordingStatusInfo {
    pub active: bool,
    pub paused: bool,
    pub device_name: Option<String>,
}

#[tauri::command]
pub async fn get_recording_status(
    state: State<'_, RecorderState>,
) -> Result<RecordingStatusInfo, String> {
    match audio_capture::get_recording_status(&state) {
        Some((is_paused, device_name)) => Ok(RecordingStatusInfo {
            active: true,
            paused: is_paused,
            device_name: Some(device_name),
        }),
        None => Ok(RecordingStatusInfo {
            active: false,
            paused: false,
            device_name: None,
        }),
    }
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, String> {
    tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| format!("Kunde inte läsa filen: {}", e))
}

#[tauri::command]
pub async fn write_binary_to_file(data_base64: String, destination: String) -> Result<(), String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data_base64)
        .map_err(|e| format!("Base64-avkodning misslyckades: {}", e))?;
    tokio::fs::write(&destination, &bytes)
        .await
        .map_err(|e| format!("Kunde inte spara filen: {}", e))
}

#[tauri::command]
pub async fn copy_file_to(source: String, destination: String) -> Result<(), String> {
    tokio::fs::copy(&source, &destination)
        .await
        .map(|_| ())
        .map_err(|e| format!("Kunde inte spara filen: {}", e))
}

#[tauri::command]
pub async fn ollama_check_health(base_url: String) -> bool {
    crate::ollama::check_health(&base_url).await
}

#[tauri::command]
pub async fn ollama_list_models(base_url: String) -> Result<Vec<crate::ollama::OllamaModel>, String> {
    crate::ollama::list_models(&base_url).await
}

#[tauri::command]
pub async fn ollama_generate(
    app: AppHandle,
    model: String,
    prompt: String,
    request_id: String,
    options: Option<crate::ollama::OllamaOptions>,
    base_url: String,
    cancellation_map: State<'_, CancellationMap>,
) -> Result<String, String> {
    let cancelled = cancellation_map.register(&request_id);
    let result = crate::ollama::generate_streaming(&app, &model, &prompt, &request_id, options, &base_url, cancelled).await;
    cancellation_map.remove(&request_id);
    result
}

#[tauri::command]
pub async fn ollama_cancel(
    request_id: String,
    cancellation_map: State<'_, CancellationMap>,
) -> Result<bool, String> {
    Ok(cancellation_map.cancel(&request_id))
}

#[tauri::command]
pub async fn ollama_cancel_all(
    cancellation_map: State<'_, CancellationMap>,
) -> Result<(), String> {
    cancellation_map.cancel_all();
    Ok(())
}

#[tauri::command]
pub fn set_meeting_detection(
    enabled: bool,
    detector: State<'_, MeetingDetector>,
    app: AppHandle,
) {
    if enabled {
        detector.start_monitoring(app);
    } else {
        detector.stop_monitoring();
    }
    log::info!("Mötesdetektering: {}", if enabled { "aktiverad" } else { "avaktiverad" });
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
