mod audio_capture;
mod commands;
mod sidecar;
mod sidecar_manager;

use audio_capture::RecorderState;
use commands::{copy_file_to, get_default_output_dir, open_file, read_file_content, run_transcription, start_recording, stop_recording};
use sidecar_manager::SidecarManager;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(RecorderState::new())
        .manage(SidecarManager::new())
        .setup(|app| {
            // Warm up models in the background
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                // Set python path for the sidecar
                let python = commands::find_python(&handle).unwrap_or_else(|_| "python".to_string());
                let sidecar: tauri::State<'_, SidecarManager> = handle.state();
                sidecar.set_python_path(python).await;

                if let Err(e) = sidecar.warmup(&handle).await {
                    eprintln!("Bakgrunds-warmup misslyckades: {}", e);
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
