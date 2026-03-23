mod audio_capture;
mod commands;
mod meeting_detector;
mod ollama;
mod sidecar;
mod sidecar_manager;

use audio_capture::RecorderState;
use commands::{copy_file_to, get_default_output_dir, list_audio_devices, ollama_check_health, ollama_generate, ollama_list_models, open_file, pause_recording, read_file_content, resume_recording, run_transcription, set_meeting_detection, start_recording, stop_recording, write_text_to_file};
use meeting_detector::MeetingDetector;
use sidecar_manager::SidecarManager;
use tauri::{Emitter, Manager};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .max_file_size(5_000_000) // 5 MB
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                .build(),
        )
        .manage(RecorderState::new())
        .manage(SidecarManager::new())
        .manage(MeetingDetector::new())
        .setup(|app| {
            // --- System tray ---
            let show_item = MenuItem::with_id(app, "show", "Visa MötesSkribent", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Avsluta", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("MötesSkribent")
                .menu(&menu)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.unminimize();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;

            // --- Warm up models in the background ---
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
            list_audio_devices,
            start_recording,
            stop_recording,
            pause_recording,
            resume_recording,
            read_file_content,
            copy_file_to,
            write_text_to_file,
            ollama_check_health,
            ollama_list_models,
            ollama_generate,
            set_meeting_detection,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                tauri::RunEvent::WindowEvent {
                    label,
                    event: tauri::WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    if label == "main" {
                        // Hide window instead of closing — app lives in tray
                        api.prevent_close();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                }
                tauri::RunEvent::Exit => {
                    let handle = app.clone();
                    tauri::async_runtime::block_on(async {
                        let sidecar: tauri::State<'_, SidecarManager> = handle.state();
                        sidecar.shutdown().await;
                    });
                    // Stop meeting detection
                    let detector: tauri::State<'_, MeetingDetector> = app.state();
                    detector.stop_monitoring();
                }
                _ => {}
            }
        });
}
