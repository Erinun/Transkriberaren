use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

type SharedWriter = Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>;

/// Shared handle that lets us signal the recording thread to stop.
/// The cpal Stream lives on its own thread (it's !Send).
struct RecordingHandle {
    running: Arc<AtomicBool>,
    writer: SharedWriter,
    thread: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
}

pub struct RecorderState {
    inner: Mutex<Option<RecordingHandle>>,
}

// SAFETY: RecordingHandle fields are all Send except the thread::JoinHandle
// which is Send. The cpal::Stream lives inside that thread, not in the handle.
unsafe impl Send for RecorderState {}
unsafe impl Sync for RecorderState {}

impl RecorderState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

#[derive(Clone, serde::Serialize)]
struct RecordingTick {
    elapsed_seconds: f64,
}

#[derive(Clone, serde::Serialize)]
struct RecordingError {
    message: String,
}

pub fn start_recording(state: &RecorderState, app: AppHandle) -> Result<(), String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Inspelning pågår redan".to_string());
    }

    // Query device info on main thread (these types are Send)
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "Ingen mikrofon hittades".to_string())?;

    let supported_config = device
        .default_input_config()
        .map_err(|e| format!("Kunde inte öppna mikrofonen: {}", e))?;

    let sample_rate = supported_config.sample_rate().0;
    let channels = supported_config.channels();
    let sample_format = supported_config.sample_format();

    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = std::env::temp_dir().join(format!("motesskribent_rec_{}.wav", timestamp));

    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = WavWriter::create(&path, spec)
        .map_err(|e| format!("Kunde inte skapa inspelningsfil: {}", e))?;
    let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));

    let running = Arc::new(AtomicBool::new(true));

    // Clone handles for the recording thread
    let writer_thread = writer.clone();
    let running_thread = running.clone();
    let app_err = app.clone();
    let num_channels = channels as usize;

    // Spawn a dedicated thread that owns the cpal Stream (which is !Send)
    let thread = std::thread::spawn(move || {
        // Re-acquire device on this thread
        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                let _ = app_err.emit(
                    "recording-error",
                    RecordingError {
                        message: "Ingen mikrofon hittades".to_string(),
                    },
                );
                return;
            }
        };

        let config = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_err.emit(
                    "recording-error",
                    RecordingError {
                        message: format!("Kunde inte öppna mikrofonen: {}", e),
                    },
                );
                return;
            }
        };

        let stream_config: cpal::StreamConfig = config.into();
        let writer_cb = writer_thread.clone();
        let running_cb = running_thread.clone();
        let app_err2 = app_err.clone();

        let err_fn = move |err: cpal::StreamError| {
            let _ = app_err2.emit(
                "recording-error",
                RecordingError {
                    message: format!("Inspelningsfel: {}", err),
                },
            );
        };

        let stream = match sample_format {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !running_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut guard) = writer_cb.lock() {
                        if let Some(ref mut w) = *guard {
                            for frame in data.chunks(num_channels) {
                                let mono: f32 =
                                    frame.iter().sum::<f32>() / num_channels as f32;
                                let sample = (mono * i16::MAX as f32)
                                    .clamp(i16::MIN as f32, i16::MAX as f32)
                                    as i16;
                                if w.write_sample(sample).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &stream_config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    if !running_cb.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(mut guard) = writer_cb.lock() {
                        if let Some(ref mut w) = *guard {
                            for frame in data.chunks(num_channels) {
                                let mono: i32 = frame.iter().map(|&s| s as i32).sum::<i32>()
                                    / num_channels as i32;
                                if w.write_sample(mono as i16).is_err() {
                                    break;
                                }
                            }
                        }
                    }
                },
                err_fn,
                None,
            ),
            format => {
                let _ = app_err.emit(
                    "recording-error",
                    RecordingError {
                        message: format!("Formatet {:?} stöds inte", format),
                    },
                );
                return;
            }
        };

        let stream = match stream {
            Ok(s) => s,
            Err(e) => {
                let _ = app_err.emit(
                    "recording-error",
                    RecordingError {
                        message: format!("Kunde inte öppna mikrofonen: {}", e),
                    },
                );
                return;
            }
        };

        if let Err(e) = stream.play() {
            let _ = app_err.emit(
                "recording-error",
                RecordingError {
                    message: format!("Kunde inte starta inspelning: {}", e),
                },
            );
            return;
        }

        // Keep thread alive while recording
        while running_thread.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        // Stream is dropped here, stopping cpal
    });

    // Spawn async tick emitter
    let running_tick = running.clone();
    let app_tick = app.clone();
    tokio::spawn(async move {
        let start = tokio::time::Instant::now();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            if !running_tick.load(Ordering::Relaxed) {
                break;
            }
            let elapsed = start.elapsed().as_secs_f64();
            let _ = app_tick.emit("recording-tick", RecordingTick { elapsed_seconds: elapsed });
        }
    });

    *guard = Some(RecordingHandle {
        running,
        writer,
        thread: Some(thread),
        path,
    });

    Ok(())
}

pub fn stop_recording(state: &RecorderState) -> Result<String, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut handle = guard
        .take()
        .ok_or_else(|| "Ingen inspelning att stoppa".to_string())?;

    // Signal the recording thread to stop
    handle.running.store(false, Ordering::Relaxed);

    // Wait for the thread to finish (drops the cpal Stream)
    if let Some(thread) = handle.thread.take() {
        let _ = thread.join();
    }

    // Finalize the WAV file
    if let Ok(mut writer_guard) = handle.writer.lock() {
        if let Some(writer) = writer_guard.take() {
            writer
                .finalize()
                .map_err(|e| format!("Kunde inte slutföra inspelningsfilen: {}", e))?;
        }
    }

    Ok(handle.path.to_string_lossy().to_string())
}
