use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter};

type SharedWriter = Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>;
type SharedProducer = Arc<Mutex<ringbuf::HeapProd<f32>>>;
type SharedConsumer = Arc<Mutex<ringbuf::HeapCons<f32>>>;

#[derive(Clone, serde::Serialize)]
pub struct RecordingResult {
    pub path: String,
    pub device_name: String,
}

/// Shared handle that lets us signal the recording threads to stop.
struct RecordingHandle {
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    paused_duration: Arc<Mutex<f64>>,
    pause_start: Arc<Mutex<Option<std::time::Instant>>>,
    writer: SharedWriter,
    #[allow(dead_code)]
    audio_level: Arc<AtomicU32>,
    mic_thread: Option<JoinHandle<()>>,
    loopback_thread: Option<JoinHandle<()>>,
    mixer_thread: Option<JoinHandle<()>>,
    path: PathBuf,
    device_name: String,
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

#[derive(Clone, serde::Serialize)]
struct RecordingWarning {
    message: String,
}

#[derive(Clone, serde::Serialize)]
struct AudioLevel {
    level: f32,
}


/// Linearly resample a buffer of samples to a target length.
fn resample_linear(input: &[f32], output_len: usize) -> Vec<f32> {
    if input.is_empty() || output_len == 0 {
        return vec![0.0; output_len];
    }
    if input.len() == output_len {
        return input.to_vec();
    }
    let mut output = Vec::with_capacity(output_len);
    let ratio = (input.len() - 1) as f64 / (output_len - 1).max(1) as f64;
    for i in 0..output_len {
        let pos = i as f64 * ratio;
        let idx = pos as usize;
        let frac = pos - idx as f64;
        if idx + 1 < input.len() {
            output.push(input[idx] * (1.0 - frac as f32) + input[idx + 1] * frac as f32);
        } else {
            output.push(input[input.len() - 1]);
        }
    }
    output
}

pub fn start_recording(
    state: &RecorderState,
    app: AppHandle,
    mode: String,
    output_device_override: Option<String>,
) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Inspelning pågår redan".to_string());
    }

    let mode_info = crate::wasapi_loopback::detect_audio_mode()?;
    if !mode_info.has_microphone {
        return Err("Ingen mikrofon hittades".to_string());
    }

    let host = cpal::default_host();

    match mode.as_str() {
        "headphones" | "speakers" => {
            let output_name = if let Some(ref override_name) = output_device_override {
                log::info!("Using manually selected output device: '{}'", override_name);
                Some(override_name.clone())
            } else if mode_info.output_device_name.is_empty() {
                None
            } else {
                Some(mode_info.output_device_name.clone())
            };
            start_recording_mixed(guard, host, app, output_name, Some(mode_info.microphone_name))
        }
        _ => Err(format!("Okänt inspelningsläge: {}", mode)),
    }
}

/// Start recording from both mic and system audio simultaneously (mixed).
fn start_recording_mixed(
    mut guard: std::sync::MutexGuard<'_, Option<RecordingHandle>>,
    host: cpal::Host,
    app: AppHandle,
    output_device_name: Option<String>,
    mic_device_name: Option<String>,
) -> Result<String, String> {
    // Find mic device by name, or fall back to default
    let mic_device = if let Some(ref name) = mic_device_name {
        host.input_devices()
            .map_err(|e| format!("Kunde inte lista mikrofoner: {}", e))?
            .find(|d| d.name().ok().as_deref() == Some(name.as_str()))
            .or_else(|| host.default_input_device())
            .ok_or_else(|| "Ingen mikrofon hittades".to_string())?
    } else {
        host.default_input_device()
            .ok_or_else(|| "Ingen mikrofon hittades".to_string())?
    };

    let mic_config = mic_device
        .default_input_config()
        .map_err(|e| format!("Kunde inte öppna mikrofonen: {}", e))?;

    let mic_sample_rate = mic_config.sample_rate().0;
    // Get loopback sample rate from WASAPI mix format (not cpal)
    let loopback_sample_rate = crate::wasapi_loopback::get_output_device_sample_rate(
        output_device_name.as_deref(),
    )
    .unwrap_or(mic_sample_rate);

    // WAV at mic sample rate
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = std::env::temp_dir().join(format!("motesskribent_rec_{}.wav", timestamp));

    // Stereo WAV: left=mic, right=system — enables channel-based speaker separation
    let spec = WavSpec {
        channels: 2,
        sample_rate: mic_sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = WavWriter::create(&path, spec)
        .map_err(|e| format!("Kunde inte skapa inspelningsfil: {}", e))?;
    let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));

    let running = Arc::new(AtomicBool::new(true));
    let paused = Arc::new(AtomicBool::new(false));
    let paused_duration = Arc::new(Mutex::new(0.0f64));
    let pause_start: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));
    let audio_level = Arc::new(AtomicU32::new(0u32));
    let mic_name_display = mic_device.name().unwrap_or_else(|_| "Mikrofon".to_string());
    let output_name_display = output_device_name.as_deref().unwrap_or("Systemljud");
    let device_name = format!("{} + {}", mic_name_display, output_name_display);

    // Ring buffer capacity: ~2 seconds at each stream's own sample rate
    let mic_rb_capacity = (mic_sample_rate as usize) * 2;
    let lb_rb_capacity = (loopback_sample_rate as usize) * 2;

    let mic_rb = HeapRb::<f32>::new(mic_rb_capacity);
    let (mic_producer, mic_consumer) = mic_rb.split();

    let loopback_rb = HeapRb::<f32>::new(lb_rb_capacity);
    let (loopback_producer, loopback_consumer) = loopback_rb.split();

    // Mic capture thread
    let running_mic = running.clone();
    let app_mic = app.clone();
    let mic_producer = Arc::new(Mutex::new(mic_producer));
    let mic_name_for_thread = mic_device_name.clone();
    let mic_thread = Some(std::thread::spawn(move || {
        run_mic_capture_thread(mic_producer, running_mic, app_mic, mic_name_for_thread);
    }));

    // Loopback capture thread
    let running_lb = running.clone();
    let app_lb = app.clone();
    let loopback_producer = Arc::new(Mutex::new(loopback_producer));
    let lb_device_name = output_device_name.clone();
    let loopback_thread = Some(std::thread::spawn(move || {
        run_loopback_capture_thread(loopback_producer, running_lb, app_lb, lb_device_name);
    }));

    // Mixer thread
    let running_mix = running.clone();
    let paused_mix = paused.clone();
    let audio_level_mix = audio_level.clone();
    let writer_mix = writer.clone();
    let mic_consumer = Arc::new(Mutex::new(mic_consumer));
    let loopback_consumer = Arc::new(Mutex::new(loopback_consumer));
    let mixer_thread = Some(std::thread::spawn(move || {
        run_mixer_thread(
            mic_consumer,
            loopback_consumer,
            writer_mix,
            running_mix,
            paused_mix,
            audio_level_mix,
            mic_sample_rate,
            loopback_sample_rate,
        );
    }));

    spawn_tick_and_level_emitters(&running, &paused, &paused_duration, &pause_start, &audio_level, &app);

    let return_name = device_name.clone();
    *guard = Some(RecordingHandle {
        running,
        paused,
        paused_duration,
        pause_start,
        writer,
        audio_level,
        mic_thread,
        loopback_thread,
        mixer_thread,
        path,
        device_name,
    });

    Ok(return_name)
}

pub fn pause_recording(state: &RecorderState) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let handle = guard
        .as_ref()
        .ok_or_else(|| "Ingen inspelning att pausa".to_string())?;

    if handle.paused.load(Ordering::Relaxed) {
        return Err("Inspelningen är redan pausad".to_string());
    }

    // Record when the pause started
    if let Ok(mut ps) = handle.pause_start.lock() {
        *ps = Some(std::time::Instant::now());
    }
    handle.paused.store(true, Ordering::Relaxed);
    Ok(())
}

pub fn resume_recording(state: &RecorderState) -> Result<(), String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    let handle = guard
        .as_ref()
        .ok_or_else(|| "Ingen inspelning att återuppta".to_string())?;

    if !handle.paused.load(Ordering::Relaxed) {
        return Err("Inspelningen är inte pausad".to_string());
    }

    // Accumulate time spent paused
    if let Ok(mut ps) = handle.pause_start.lock() {
        if let Some(start) = ps.take() {
            if let Ok(mut pd) = handle.paused_duration.lock() {
                *pd += start.elapsed().as_secs_f64();
            }
        }
    }
    handle.paused.store(false, Ordering::Relaxed);
    Ok(())
}

pub fn stop_recording(state: &RecorderState) -> Result<RecordingResult, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut handle = guard
        .take()
        .ok_or_else(|| "Ingen inspelning att stoppa".to_string())?;

    // If stopped while paused, accumulate final pause duration
    if handle.paused.load(Ordering::Relaxed) {
        if let Ok(mut ps) = handle.pause_start.lock() {
            if let Some(start) = ps.take() {
                if let Ok(mut pd) = handle.paused_duration.lock() {
                    *pd += start.elapsed().as_secs_f64();
                }
            }
        }
        handle.paused.store(false, Ordering::Relaxed);
    }

    // Signal all threads to stop
    handle.running.store(false, Ordering::Relaxed);

    // Wait for threads to finish
    if let Some(t) = handle.mic_thread.take() {
        let _ = t.join();
    }
    if let Some(t) = handle.loopback_thread.take() {
        let _ = t.join();
    }
    if let Some(t) = handle.mixer_thread.take() {
        let _ = t.join();
    }

    // Finalize the WAV file
    if let Ok(mut writer_guard) = handle.writer.lock() {
        if let Some(writer) = writer_guard.take() {
            writer
                .finalize()
                .map_err(|e| format!("Kunde inte slutföra inspelningsfilen: {}", e))?;
        }
    }

    Ok(RecordingResult {
        path: handle.path.to_string_lossy().to_string(),
        device_name: handle.device_name,
    })
}

pub fn get_recording_status(state: &RecorderState) -> Option<(bool, String)> {
    let guard = state.inner.lock().ok()?;
    guard.as_ref().map(|handle| {
        let is_paused = handle.paused.load(Ordering::Relaxed);
        (is_paused, handle.device_name.clone())
    })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn spawn_tick_and_level_emitters(
    running: &Arc<AtomicBool>,
    paused: &Arc<AtomicBool>,
    paused_duration: &Arc<Mutex<f64>>,
    pause_start: &Arc<Mutex<Option<std::time::Instant>>>,
    audio_level: &Arc<AtomicU32>,
    app: &AppHandle,
) {
    let running_tick = running.clone();
    let paused_tick = paused.clone();
    let paused_duration_tick = paused_duration.clone();
    let pause_start_tick = pause_start.clone();
    let app_tick = app.clone();
    tokio::spawn(async move {
        let start = tokio::time::Instant::now();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            interval.tick().await;
            if !running_tick.load(Ordering::Relaxed) {
                break;
            }
            let total = start.elapsed().as_secs_f64();
            let acc_paused = *paused_duration_tick.lock().unwrap_or_else(|e| e.into_inner());
            let current_pause = if paused_tick.load(Ordering::Relaxed) {
                pause_start_tick
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(0.0)
            } else {
                0.0
            };
            let elapsed = (total - acc_paused - current_pause).max(0.0);
            let _ = app_tick.emit("recording-tick", RecordingTick { elapsed_seconds: elapsed });
        }
    });

    let running_level = running.clone();
    let audio_level_emit = audio_level.clone();
    let app_level = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            interval.tick().await;
            if !running_level.load(Ordering::Relaxed) {
                break;
            }
            let level = f32::from_bits(audio_level_emit.load(Ordering::Relaxed));
            let _ = app_level.emit("recording-level", AudioLevel { level });
        }
    });
}

// ─── Mic capture thread (for MicAndSystem mode) ─────────────────────────────

fn run_mic_capture_thread(
    producer: SharedProducer,
    running: Arc<AtomicBool>,
    app: AppHandle,
    mic_device_name: Option<String>,
) {
    let host = cpal::default_host();
    let device = if let Some(ref name) = mic_device_name {
        match host.input_devices() {
            Ok(devices) => devices
                .into_iter()
                .find(|d| d.name().ok().as_deref() == Some(name.as_str()))
                .or_else(|| host.default_input_device()),
            Err(_) => host.default_input_device(),
        }
    } else {
        host.default_input_device()
    };
    let device = match device {
        Some(d) => d,
        None => {
            let _ = app.emit(
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
            let _ = app.emit(
                "recording-error",
                RecordingError {
                    message: format!("Kunde inte öppna mikrofonen: {}", e),
                },
            );
            return;
        }
    };

    let sample_format = config.sample_format();
    let num_channels = config.channels() as usize;
    let mic_name = device.name().unwrap_or_else(|_| "okänd".to_string());
    log::info!(
        "Mic capture: device='{}', format={:?}, channels={}, sample_rate={}",
        mic_name,
        sample_format,
        num_channels,
        config.sample_rate().0,
    );
    let stream_config: cpal::StreamConfig = config.into();
    let running_cb = running.clone();
    let app_err = app.clone();

    // Heartbeat: tracks when the mic callback last fired (epoch millis)
    let mic_heartbeat = Arc::new(AtomicU64::new(0));
    let heartbeat_f32 = mic_heartbeat.clone();
    let heartbeat_i16 = mic_heartbeat.clone();

    let err_fn = move |err: cpal::StreamError| {
        log::error!("Mic stream error: {}", err);
        let _ = app_err.emit(
            "recording-error",
            RecordingError {
                message: format!("Mikrofonfel: {}", err),
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
                // Update heartbeat
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                heartbeat_f32.store(now, Ordering::Relaxed);

                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    mono_samples.push(frame.iter().sum::<f32>() / num_channels as f32);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
                } else {
                    log::warn!("Mic producer lock failed, dropping {} samples", mono_samples.len());
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
                // Update heartbeat
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                heartbeat_i16.store(now, Ordering::Relaxed);

                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    let m: f32 = frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>()
                        / num_channels as f32;
                    mono_samples.push(m);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
                } else {
                    log::warn!("Mic producer lock failed, dropping {} samples", mono_samples.len());
                }
            },
            err_fn,
            None,
        ),
        format => {
            let _ = app.emit(
                "recording-error",
                RecordingError {
                    message: format!("Mikrofonformat {:?} stöds inte", format),
                },
            );
            return;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit(
                "recording-error",
                RecordingError {
                    message: format!("Kunde inte öppna mikrofonen: {}", e),
                },
            );
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = app.emit(
            "recording-error",
            RecordingError {
                message: format!("Kunde inte starta mikrofon: {}", e),
            },
        );
        return;
    }

    log::info!("Mic capture started successfully on '{}'", mic_name);

    let mut heartbeat_warned = false;
    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(500));

        // Check if mic callback is still firing
        let last_ts = mic_heartbeat.load(Ordering::Relaxed);
        if last_ts > 0 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            let age_ms = now.saturating_sub(last_ts);
            if age_ms > 2000 {
                if !heartbeat_warned {
                    log::warn!(
                        "MIC HEARTBEAT: Callback hasn't fired for {}ms — stream may be dead!",
                        age_ms
                    );
                    let _ = app.emit(
                        "recording-warning",
                        RecordingWarning {
                            message: format!(
                                "Mikrofonen verkar ha slutat leverera ljud ({}s utan data)",
                                age_ms / 1000
                            ),
                        },
                    );
                    heartbeat_warned = true;
                }
            } else {
                heartbeat_warned = false;
            }
        }
    }

    log::info!("Mic capture thread ending");
}

// ─── Loopback capture thread (WASAPI loopback on output device) ─────────────

fn run_loopback_capture_thread(
    producer: SharedProducer,
    running: Arc<AtomicBool>,
    app: AppHandle,
    output_device_name: Option<String>,
) {
    // Use direct WASAPI loopback with polling (not cpal's broken event-driven approach)
    let capture = match crate::wasapi_loopback::WasapiLoopbackCapture::new(
        output_device_name.as_deref(),
    ) {
        Ok(c) => c,
        Err(e) => {
            log::error!("WASAPI loopback init failed: {}", e);
            let _ = app.emit(
                "recording-warning",
                RecordingWarning {
                    message: format!("{}, fortsätter med bara mikrofon", e),
                },
            );
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return;
        }
    };

    if let Err(e) = capture.start() {
        log::error!("WASAPI loopback start failed: {}", e);
        let _ = app.emit(
            "recording-warning",
            RecordingWarning {
                message: format!("{}, fortsätter med bara mikrofon", e),
            },
        );
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        return;
    }

    log::info!("WASAPI loopback capture started (polling mode)");

    let mut total_samples: u64 = 0;
    let mut silence_start = std::time::Instant::now();
    let mut warned_silence = false;

    while running.load(Ordering::Relaxed) {
        let mut samples = Vec::new();
        match capture.capture_samples(&mut samples) {
            Ok(count) => {
                if !samples.is_empty() {
                    // Check for actual audio (not just silence)
                    let has_audio = samples.iter().any(|&s| s.abs() > 0.0001);

                    if has_audio {
                        silence_start = std::time::Instant::now();
                        warned_silence = false;
                    } else if !warned_silence && silence_start.elapsed().as_secs() > 10 {
                        let _ = app.emit(
                            "recording-warning",
                            RecordingWarning {
                                message: format!(
                                    "Inget systemljud detekterat på 10 sekunder (lyssnar på: {})",
                                    capture.device_name()
                                ),
                            },
                        );
                        warned_silence = true;
                    }

                    if let Ok(mut prod) = producer.lock() {
                        prod.push_slice(&samples);
                    }
                    total_samples += count as u64;
                } else {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            }
            Err(e) => {
                log::error!("Loopback capture error: {}", e);
                let _ = app.emit(
                    "recording-warning",
                    RecordingWarning {
                        message: format!("Systemljudfel: {}", e),
                    },
                );
                // Continue trying — transient errors may recover
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }

    capture.stop();
    log::info!(
        "WASAPI loopback capture ended, total samples: {}",
        total_samples
    );
}

// ─── Mixer thread ────────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn run_mixer_thread(
    mic_consumer: SharedConsumer,
    loopback_consumer: SharedConsumer,
    writer: SharedWriter,
    running: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    audio_level: Arc<AtomicU32>,
    mic_sample_rate: u32,
    loopback_sample_rate: u32,
) {
    // Output chunk size: 20ms worth of mic-rate samples
    let chunk_size = (mic_sample_rate as usize) / 50;
    let needs_resample = mic_sample_rate != loopback_sample_rate;

    // Accumulator buffers — hold leftover samples between cycles so nothing is lost.
    // The old code popped from the ring buffer and discarded excess, losing loopback audio.
    let mut mic_accum: Vec<f32> = Vec::new();
    let mut lb_accum: Vec<f32> = Vec::new();

    // Mic watchdog: track how long mic_accum has been empty
    let mut mic_dry_since: Option<std::time::Instant> = None;
    let mut mic_dry_warned = false;

    while running.load(Ordering::Relaxed) {
        // 1. Drain all available from ring buffers into accumulators
        if let Ok(mut cons) = mic_consumer.lock() {
            let avail = cons.occupied_len();
            if avail > 0 {
                let start = mic_accum.len();
                mic_accum.resize(start + avail, 0.0);
                cons.pop_slice(&mut mic_accum[start..]);
            }
        }
        if let Ok(mut cons) = loopback_consumer.lock() {
            let avail = cons.occupied_len();
            if avail > 0 {
                let start = lb_accum.len();
                lb_accum.resize(start + avail, 0.0);
                cons.pop_slice(&mut lb_accum[start..]);
            }
        }

        // Mic watchdog: detect if mic stream has stopped delivering data
        if mic_accum.is_empty() {
            if mic_dry_since.is_none() {
                mic_dry_since = Some(std::time::Instant::now());
            }
            if let Some(since) = mic_dry_since {
                let dry_secs = since.elapsed().as_secs();
                if dry_secs >= 2 && !mic_dry_warned {
                    log::warn!(
                        "MIC WATCHDOG: No mic data for {}s — callback may have stopped!",
                        dry_secs
                    );
                    mic_dry_warned = true;
                } else if dry_secs >= 5 && dry_secs % 5 == 0 {
                    log::warn!("MIC WATCHDOG: Still no mic data after {}s", dry_secs);
                }
            }
        } else {
            if mic_dry_warned {
                log::info!("MIC WATCHDOG: Mic data resumed after dry period");
            }
            mic_dry_since = None;
            mic_dry_warned = false;
        }

        // Nothing from either source → sleep briefly
        if mic_accum.is_empty() && lb_accum.is_empty() {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        // When paused: drain accumulators to prevent buildup, skip WAV writing
        if paused.load(Ordering::Relaxed) {
            mic_accum.clear();
            lb_accum.clear();
            audio_level.store(0u32, Ordering::Relaxed);
            std::thread::sleep(std::time::Duration::from_millis(20));
            continue;
        }

        // 2. Mic is timing master — output_len is based on available mic data
        let output_len = if !mic_accum.is_empty() {
            mic_accum.len().min(chunk_size)
        } else {
            // No mic data yet but loopback has data — wait briefly for mic
            // to avoid writing loopback-only frames that misalign the streams
            std::thread::sleep(std::time::Duration::from_millis(5));
            // If mic still empty after wait, use lb to avoid stalling
            if mic_accum.is_empty() {
                let lb_as_output = if needs_resample {
                    ((lb_accum.len() as f64) * (mic_sample_rate as f64)
                        / (loopback_sample_rate as f64))
                        .floor() as usize
                } else {
                    lb_accum.len()
                };
                lb_as_output.min(chunk_size)
            } else {
                mic_accum.len().min(chunk_size)
            }
        };

        if output_len == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        // 3. Consume mic samples
        let mic_consume = output_len.min(mic_accum.len());
        let mic_data: Vec<f32> = mic_accum.drain(..mic_consume).collect();

        // 4. Consume proportional loopback samples and resample to output rate
        let lb_needed = if needs_resample {
            ((output_len as f64) * (loopback_sample_rate as f64) / (mic_sample_rate as f64))
                .ceil() as usize
        } else {
            output_len
        };
        let lb_consume = lb_needed.min(lb_accum.len());
        let lb_raw: Vec<f32> = lb_accum.drain(..lb_consume).collect();

        let lb_resampled = if lb_raw.is_empty() {
            vec![0.0f32; output_len]
        } else if needs_resample || lb_raw.len() != output_len {
            resample_linear(&lb_raw, output_len)
        } else {
            lb_raw
        };

        // 5. Prevent accumulator drift — cap at 1 second max
        let max_mic = mic_sample_rate as usize;
        let max_lb = loopback_sample_rate as usize;
        if mic_accum.len() > max_mic {
            let excess = mic_accum.len() - max_mic;
            mic_accum.drain(..excess);
            log::warn!("Mic accumulator overflow, dropped {} samples", excess);
        }
        if lb_accum.len() > max_lb {
            let excess = lb_accum.len() - max_lb;
            lb_accum.drain(..excess);
            log::warn!("Loopback accumulator overflow, dropped {} samples", excess);
        }

        // 6. Write interleaved stereo: left=mic, right=system
        let mut sum_sq = 0.0f32;
        if let Ok(mut guard) = writer.lock() {
            if let Some(ref mut w) = *guard {
                for i in 0..output_len {
                    let mic_s = if i < mic_data.len() { mic_data[i] } else { 0.0 };
                    let lb_s = if i < lb_resampled.len() {
                        lb_resampled[i]
                    } else {
                        0.0
                    };

                    // Left channel: mic
                    let left = (mic_s.clamp(-1.0, 1.0) * i16::MAX as f32)
                        .clamp(i16::MIN as f32, i16::MAX as f32)
                        as i16;
                    // Right channel: system
                    let right = (lb_s.clamp(-1.0, 1.0) * i16::MAX as f32)
                        .clamp(i16::MIN as f32, i16::MAX as f32)
                        as i16;

                    if w.write_sample(left).is_err() {
                        break;
                    }
                    if w.write_sample(right).is_err() {
                        break;
                    }

                    // VU meter from virtual mix
                    let mixed = (mic_s * 0.7 + lb_s * 0.7).clamp(-1.0, 1.0);
                    sum_sq += mixed * mixed;
                }
            }
        }

        // Update audio level from virtual mix
        if output_len > 0 {
            let rms = (sum_sq / output_len as f32).sqrt();
            audio_level.store(rms.to_bits(), Ordering::Relaxed);
        }
    }
}
