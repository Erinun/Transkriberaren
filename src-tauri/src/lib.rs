mod audio_capture;
mod commands;
mod ollama;
mod sidecar;
mod sidecar_manager;

use audio_capture::RecorderState;
use commands::{copy_file_to, get_default_output_dir, ollama_check_health, ollama_generate, ollama_list_models, open_file, read_file_content, run_transcription, start_recording, stop_recording, write_text_to_file};
use sidecar_manager::SidecarManager;
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(5_000_000) // 5 MB
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .manage(RecorderState::new())
        .manage(SidecarManager::new())
        .setup(|app| {
            // Warm up models in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Emit starting status
                let _ = handle.emit("sidecar-status", "starting");

                // Set python path for the sidecar (only used if no bundled exe)
                let python = commands::find_python(&handle).unwrap_or_else(|_| "python".to_string());
                log::info!("Python-sökväg: {}", python);
                let sidecar: tauri::State<'_, SidecarManager> = handle.state();
                sidecar.set_python_path(python).await;

                let _ = handle.emit("sidecar-status", "warming_up");

                match sidecar.warmup(&handle).await {
                    Ok(diarization_available) => {
                        log::info!("Sidecar warmup klar, diarization: {}", diarization_available);
                        let _ = handle.emit("sidecar-status", "ready");
                        let _ = handle.emit("diarization-status", diarization_available);
                    }
                    Err(e) => {
                        log::error!("Bakgrunds-warmup misslyckades: {}", e);
                        let _ = handle.emit("sidecar-status", "error");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_transcription,
            open_file,
            get_default_output_dir,
            start_recording,
            stop_recording,
            read_file_content,
            copy_file_to,
            write_text_to_file,
            ollama_check_health,
            ollama_list_models,
            ollama_generate,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let handle = app.clone();
                tauri::async_runtime::block_on(async {
                    let sidecar: tauri::State<'_, SidecarManager> = handle.state();
                    sidecar.shutdown().await;
                });
            }
        });
}
