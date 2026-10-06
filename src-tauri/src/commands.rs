use crate::audio_capture::{self, RecorderState, RecordingResult};
use crate::meeting_detector::MeetingDetector;
use crate::llm::{self, CancellationMap};
use crate::secrets;
use crate::sidecar::{run_python_pipeline, TranscriptionConfig};
use crate::sidecar_manager::SidecarManager;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State};

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
pub fn detect_audio_mode() -> Result<crate::wasapi_loopback::AudioModeInfo, String> {
    crate::wasapi_loopback::detect_audio_mode()
}

#[tauri::command]
pub fn list_output_devices() -> Result<Vec<crate::wasapi_loopback::OutputDeviceInfo>, String> {
    crate::wasapi_loopback::list_output_devices()
}

#[tauri::command]
pub async fn start_recording(
    state: State<'_, RecorderState>,
    app: AppHandle,
    mode: String,
    output_device_override: Option<String>,
) -> Result<String, String> {
    audio_capture::start_recording(&state, app, mode, output_device_override)
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

// ─── AI-leverantör (OpenAI-kompatibel, text → text) ──────────────────────────

fn llm_endpoint(provider_id: &str, base_url: &str) -> Result<llm::Endpoint, String> {
    let key = secrets::get_api_key(&secrets::OsKeyring, provider_id)?;
    llm::Endpoint::new(base_url, key)
}

/// Spara (eller med tom sträng: ta bort) API-nyckeln för en leverantör.
#[tauri::command]
pub fn llm_set_api_key(provider_id: String, api_key: String) -> Result<(), String> {
    secrets::set_api_key(&secrets::OsKeyring, &provider_id, &api_key)
}

/// Finns en sparad nyckel? Själva nyckeln lämnas aldrig ut till webbvyn.
#[tauri::command]
pub fn llm_has_api_key(provider_id: String) -> Result<bool, String> {
    Ok(secrets::get_api_key(&secrets::OsKeyring, &provider_id)?.is_some())
}

#[tauri::command]
pub fn llm_delete_api_key(provider_id: String) -> Result<(), String> {
    secrets::delete_api_key(&secrets::OsKeyring, &provider_id)
}

#[tauri::command]
pub async fn llm_list_models(provider_id: String, base_url: String) -> Result<Vec<llm::LlmModel>, String> {
    llm::list_models(&llm_endpoint(&provider_id, &base_url)?).await
}

#[tauri::command]
pub async fn llm_test_connection(
    provider_id: String,
    base_url: String,
    model: Option<String>,
) -> Result<llm::ConnectionTest, String> {
    let endpoint = llm_endpoint(&provider_id, &base_url)?;
    Ok(llm::test_connection(&endpoint, model.as_deref()).await)
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct LlmGenerateOptions {
    pub temperature: Option<f64>,
    pub max_tokens: Option<u32>,
}

/// Strömmande generering. Text skickas som "llm-event" (token/done/error).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn llm_generate(
    app: AppHandle,
    request_id: String,
    provider_id: String,
    base_url: String,
    model: String,
    system: Option<String>,
    prompt: String,
    options: Option<LlmGenerateOptions>,
    cancellation_map: State<'_, CancellationMap>,
) -> Result<String, String> {
    let cancelled = cancellation_map.register(&request_id);
    let result = run_llm_generate(&app, &request_id, &provider_id, &base_url, model, system, prompt, options, cancelled).await;
    cancellation_map.remove(&request_id);

    let mut event = llm::LlmEvent {
        request_id: request_id.clone(),
        event_type: String::new(),
        seq: u64::MAX,
        token: None,
        error: None,
        full_text: None,
    };
    match &result {
        Ok(text) => {
            event.event_type = "done".into();
            event.full_text = Some(text.clone());
        }
        Err(e) => {
            event.event_type = "error".into();
            event.error = Some(e.clone());
        }
    }
    let _ = app.emit("llm-event", &event);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_llm_generate(
    app: &AppHandle,
    request_id: &str,
    provider_id: &str,
    base_url: &str,
    model: String,
    system: Option<String>,
    prompt: String,
    options: Option<LlmGenerateOptions>,
    cancelled: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<String, String> {
    if model.trim().is_empty() {
        return Err("Ingen modell vald för AI-bearbetning.".into());
    }
    let endpoint = llm_endpoint(provider_id, base_url)?;
    let mut messages = Vec::new();
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        messages.push(llm::ChatMessage::system(&sys));
    }
    messages.push(llm::ChatMessage::user(&prompt));
    let opts = options.unwrap_or(LlmGenerateOptions { temperature: None, max_tokens: None });
    let req = llm::ChatRequest {
        model: model.trim().to_string(),
        messages,
        temperature: Some(opts.temperature.unwrap_or(0.3)),
        max_tokens: opts.max_tokens,
        response_format: None,
    };

    let mut batcher = llm::TokenBatcher::default();
    let mut seq: u64 = 0;
    let emit_token = |seq: &mut u64, token: String| {
        *seq += 1;
        let _ = app.emit("llm-event", llm::LlmEvent {
            request_id: request_id.to_string(),
            event_type: "token".into(),
            seq: *seq,
            token: Some(token),
            error: None,
            full_text: None,
        });
    };
    let text = llm::chat_stream(&endpoint, &req, cancelled, |t| {
        if let Some(batch) = batcher.push(t) {
            emit_token(&mut seq, batch);
        }
    })
    .await?;
    if let Some(rest) = batcher.flush() {
        emit_token(&mut seq, rest);
    }
    Ok(text)
}

#[tauri::command]
pub async fn llm_cancel(request_id: String, cancellation_map: State<'_, CancellationMap>) -> Result<bool, String> {
    Ok(cancellation_map.cancel(&request_id))
}

#[tauri::command]
pub async fn llm_cancel_all(cancellation_map: State<'_, CancellationMap>) -> Result<(), String> {
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

/// Transkriberingsmotorer som sidecarn känner till. Den första är standard.
pub const TRANSCRIPTION_ENGINES: [&str; 2] = ["pianissimo", "kb-whisper"];
const ENGINE_PREFERENCE_FILE: &str = "transcription_engine.txt";

fn engine_preference_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(ENGINE_PREFERENCE_FILE))
}

/// Läs vald motor från fil i app-konfigkatalogen. Okänt eller saknat värde ger standardmotorn.
pub fn read_engine_preference(path: Option<&Path>) -> String {
    path.and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| TRANSCRIPTION_ENGINES.contains(&s.as_str()))
        .unwrap_or_else(|| TRANSCRIPTION_ENGINES[0].to_string())
}

pub fn load_engine_preference(app: &AppHandle) -> String {
    read_engine_preference(engine_preference_path(app).as_deref())
}

/// Spara vald motor så att nästa uppstart värmer upp rätt modell.
#[tauri::command]
pub fn set_transcription_engine(app: AppHandle, engine: String) -> Result<(), String> {
    if !TRANSCRIPTION_ENGINES.contains(&engine.as_str()) {
        return Err(format!("Okänd transkriberingsmotor: {}", engine));
    }
    let path = engine_preference_path(&app).ok_or("Hittar ingen konfigurationskatalog")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Kunde inte skapa konfigurationskatalog: {}", e))?;
    }
    std::fs::write(&path, &engine).map_err(|e| format!("Kunde inte spara motorval: {}", e))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn engine_preference_defaults_to_pianissimo() {
        assert_eq!(read_engine_preference(None), "pianissimo");
        assert_eq!(read_engine_preference(Some(Path::new("/finns/inte.txt"))), "pianissimo");
    }

    #[test]
    fn engine_preference_reads_valid_and_rejects_unknown() {
        let dir = std::env::temp_dir().join(format!("ms-engine-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("e.txt");
        std::fs::write(&file, "kb-whisper\n").unwrap();
        assert_eq!(read_engine_preference(Some(&file)), "kb-whisper");
        std::fs::write(&file, "nagot-annat").unwrap();
        assert_eq!(read_engine_preference(Some(&file)), "pianissimo");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
