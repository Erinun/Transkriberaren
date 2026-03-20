use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter};

type SharedWriter = Arc<Mutex<Option<WavWriter<BufWriter<File>>>>>;
type SharedProducer = Arc<Mutex<ringbuf::HeapProd<f32>>>;
type SharedConsumer = Arc<Mutex<ringbuf::HeapCons<f32>>>;

#[derive(Clone, serde::Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
    pub is_loopback: bool,
    pub category: String,
}

#[derive(Clone, serde::Serialize)]
pub struct RecordingResult {
    pub path: String,
    pub device_name: String,
}

/// Shared handle that lets us signal the recording threads to stop.
struct RecordingHandle {
    running: Arc<AtomicBool>,
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

/// Which device to use on the recording thread.
#[derive(Clone)]
enum DeviceSelection {
    DefaultInput,
    Loopback,
    NamedLoopback(String),
    MicAndSystem,
    MicAndNamedOutput(String),
    NamedInput(String),
}

/// Find an output device by name.
fn find_output_device_by_name(name: &str) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    let output_devices = host
        .output_devices()
        .map_err(|e| format!("Kunde inte lista utgångsenheter: {}", e))?;
    output_devices
        .into_iter()
        .find(|d| d.name().ok().as_deref() == Some(name))
        .ok_or_else(|| format!("Utgångsenheten '{}' hittades inte", name))
}

pub fn list_audio_devices() -> Vec<AudioDevice> {
    let host = cpal::default_host();
    let mut devices = Vec::new();

    // Always include "default input"
    let default_input_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    devices.push(AudioDevice {
        id: "default_input".to_string(),
        name: "Standardmikrofon".to_string(),
        is_loopback: false,
        category: "input".to_string(),
    });

    // Add named input devices (skip the one matching default to avoid duplicate)
    if let Ok(input_devices) = host.input_devices() {
        for dev in input_devices {
            if let Ok(name) = dev.name() {
                if Some(&name) == default_input_name.as_ref() {
                    continue;
                }
                devices.push(AudioDevice {
                    id: format!("input:{}", name),
                    name,
                    is_loopback: false,
                    category: "input".to_string(),
                });
            }
        }
    }

    // Enumerate output devices for loopback and mixed options
    let default_output_name = host
        .default_output_device()
        .and_then(|d| d.name().ok());

    if default_output_name.is_some() {
        // Generic loopback (default output) — backwards-compatible
        devices.push(AudioDevice {
            id: "loopback".to_string(),
            name: "Systemljud (standard)".to_string(),
            is_loopback: true,
            category: "loopback".to_string(),
        });

        // Per-output-device loopback entries
        if let Ok(output_devices) = host.output_devices() {
            for dev in output_devices {
                if let Ok(name) = dev.name() {
                    // Skip the default — already covered by generic "loopback"
                    if Some(&name) == default_output_name.as_ref() {
                        continue;
                    }
                    devices.push(AudioDevice {
                        id: format!("loopback:{}", name),
                        name: format!("Systemljud via {}", name),
                        is_loopback: true,
                        category: "loopback".to_string(),
                    });
                }
            }
        }

        // Generic mic + system (default output) — backwards-compatible
        devices.push(AudioDevice {
            id: "mic_and_system".to_string(),
            name: "Mikrofon + Systemljud (standard)".to_string(),
            is_loopback: false,
            category: "mixed".to_string(),
        });

        // Per-output-device mic + output entries
        if let Ok(output_devices) = host.output_devices() {
            for dev in output_devices {
                if let Ok(name) = dev.name() {
                    if Some(&name) == default_output_name.as_ref() {
                        continue;
                    }
                    devices.push(AudioDevice {
                        id: format!("mic_and_output:{}", name),
                        name: format!("Mikrofon + {}", name),
                        is_loopback: false,
                        category: "mixed".to_string(),
                    });
                }
            }
        }
    }

    devices
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
    device_id: Option<String>,
) -> Result<String, String> {
    let guard = state.inner.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Err("Inspelning pågår redan".to_string());
    }

    let selection = match device_id.as_deref() {
        None | Some("default_input") => DeviceSelection::DefaultInput,
        Some("loopback") => DeviceSelection::Loopback,
        Some("mic_and_system") => DeviceSelection::MicAndSystem,
        Some(id) if id.starts_with("loopback:") => {
            DeviceSelection::NamedLoopback(id["loopback:".len()..].to_string())
        }
        Some(id) if id.starts_with("mic_and_output:") => {
            DeviceSelection::MicAndNamedOutput(id["mic_and_output:".len()..].to_string())
        }
        Some(id) if id.starts_with("input:") => {
            DeviceSelection::NamedInput(id["input:".len()..].to_string())
        }
        Some(other) => return Err(format!("Okänt enhets-id: {}", other)),
    };

    let host = cpal::default_host();

    match selection {
        DeviceSelection::MicAndSystem => {
            start_recording_mixed(guard, host, app, None)
        }
        DeviceSelection::MicAndNamedOutput(ref name) => {
            start_recording_mixed(guard, host, app, Some(name.clone()))
        }
        _ => {
            start_recording_single(guard, host, app, selection)
        }
    }
}

/// Start recording from a single device (mic, loopback, or named input).
fn start_recording_single(
    mut guard: std::sync::MutexGuard<'_, Option<RecordingHandle>>,
    host: cpal::Host,
    app: AppHandle,
    selection: DeviceSelection,
) -> Result<String, String> {
    let (device, supported_config, device_name) = match &selection {
        DeviceSelection::DefaultInput => {
            let device = host
                .default_input_device()
                .ok_or_else(|| "Ingen mikrofon hittades".to_string())?;
            let name = device.name().unwrap_or_else(|_| "Standardmikrofon".to_string());
            let cfg = device
                .default_input_config()
                .map_err(|e| format!("Kunde inte öppna mikrofonen: {}", e))?;
            (device, cfg, name)
        }
        DeviceSelection::Loopback => {
            let device = host
                .default_output_device()
                .ok_or_else(|| "Ingen utgångsenhet hittades".to_string())?;
            let name = "Systemljud (loopback)".to_string();
            let cfg = device
                .default_output_config()
                .map_err(|e| format!("Kunde inte öppna loopback-enheten: {}", e))?;
            (device, cfg, name)
        }
        DeviceSelection::NamedLoopback(target_name) => {
            let device = find_output_device_by_name(target_name)?;
            let name = format!("Systemljud via {}", target_name);
            let cfg = device
                .default_output_config()
                .map_err(|e| format!("Kunde inte öppna loopback-enheten: {}", e))?;
            (device, cfg, name)
        }
        DeviceSelection::NamedInput(target_name) => {
            let input_devices = host
                .input_devices()
                .map_err(|e| format!("Kunde inte lista enheter: {}", e))?;
            let device = input_devices
                .into_iter()
                .find(|d| d.name().ok().as_deref() == Some(target_name.as_str()))
                .ok_or_else(|| format!("Enheten '{}' hittades inte", target_name))?;
            let name = device.name().unwrap_or_else(|_| target_name.clone());
            let cfg = device
                .default_input_config()
                .map_err(|e| format!("Kunde inte öppna enheten: {}", e))?;
            (device, cfg, name)
        }
        DeviceSelection::MicAndSystem | DeviceSelection::MicAndNamedOutput(_) => unreachable!(),
    };

    let _ = device; // We only needed it for config; will re-acquire on thread

    let sample_rate = supported_config.sample_rate().0;
    let sample_format = supported_config.sample_format();
    let channels = supported_config.channels();
    let num_channels = channels as usize;

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
    let audio_level = Arc::new(AtomicU32::new(0u32));

    let writer_thread = writer.clone();
    let running_thread = running.clone();
    let audio_level_thread = audio_level.clone();
    let app_err = app.clone();
    let selection_clone = selection.clone();
    let return_name = device_name.clone();

    let mic_thread = Some(std::thread::spawn(move || {
        // Re-acquire device on this thread
        let host = cpal::default_host();
        let device = match &selection_clone {
            DeviceSelection::DefaultInput => match host.default_input_device() {
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
            },
            DeviceSelection::Loopback => match host.default_output_device() {
                Some(d) => d,
                None => {
                    let _ = app_err.emit(
                        "recording-error",
                        RecordingError {
                            message: "Ingen utgångsenhet hittades".to_string(),
                        },
                    );
                    return;
                }
            },
            DeviceSelection::NamedLoopback(target_name) => {
                match find_output_device_by_name(target_name) {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = app_err.emit(
                            "recording-error",
                            RecordingError { message: e },
                        );
                        return;
                    }
                }
            }
            DeviceSelection::NamedInput(target_name) => {
                match host.input_devices() {
                    Ok(devs) => {
                        match devs
                            .into_iter()
                            .find(|d| d.name().ok().as_deref() == Some(target_name.as_str()))
                        {
                            Some(d) => d,
                            None => {
                                let _ = app_err.emit(
                                    "recording-error",
                                    RecordingError {
                                        message: format!("Enheten '{}' hittades inte", target_name),
                                    },
                                );
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        let _ = app_err.emit(
                            "recording-error",
                            RecordingError {
                                message: format!("Kunde inte lista enheter: {}", e),
                            },
                        );
                        return;
                    }
                }
            }
            DeviceSelection::MicAndSystem | DeviceSelection::MicAndNamedOutput(_) => unreachable!(),
        };

        let config = match &selection_clone {
            DeviceSelection::Loopback | DeviceSelection::NamedLoopback(_) => match device.default_output_config() {
                Ok(c) => c,
                Err(e) => {
                    let _ = app_err.emit(
                        "recording-error",
                        RecordingError {
                            message: format!("Kunde inte öppna loopback-enheten: {}", e),
                        },
                    );
                    return;
                }
            },
            _ => match device.default_input_config() {
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
            },
        };

        let stream_config: cpal::StreamConfig = config.into();
        let writer_cb = writer_thread.clone();
        let running_cb = running_thread.clone();
        let audio_level_cb = audio_level_thread.clone();
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
                    let frame_count = data.len() / num_channels;
                    if frame_count > 0 {
                        let sum_sq: f32 = data.chunks(num_channels)
                            .map(|f| {
                                let m: f32 = f.iter().sum::<f32>() / num_channels as f32;
                                m * m
                            })
                            .sum();
                        let rms = (sum_sq / frame_count as f32).sqrt();
                        audio_level_cb.store(rms.to_bits(), Ordering::Relaxed);
                    }
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => {
                let audio_level_i16 = audio_level_cb.clone();
                device.build_input_stream(
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
                        let frame_count = data.len() / num_channels;
                        if frame_count > 0 {
                            let sum_sq: f32 = data.chunks(num_channels)
                                .map(|f| {
                                    let m: f32 = f.iter().map(|&s| s as f32 / 32768.0).sum::<f32>() / num_channels as f32;
                                    m * m
                                })
                                .sum();
                            let rms = (sum_sq / frame_count as f32).sqrt();
                            audio_level_i16.store(rms.to_bits(), Ordering::Relaxed);
                        }
                    },
                    err_fn,
                    None,
                )
            }
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
                        message: format!("Kunde inte öppna enheten: {}", e),
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

        while running_thread.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }));

    spawn_tick_and_level_emitters(&running, &audio_level, &app);

    *guard = Some(RecordingHandle {
        running,
        writer,
        audio_level,
        mic_thread,
        loopback_thread: None,
        mixer_thread: None,
        path,
        device_name,
    });

    Ok(return_name)
}

/// Start recording from both mic and system audio simultaneously (mixed).
fn start_recording_mixed(
    mut guard: std::sync::MutexGuard<'_, Option<RecordingHandle>>,
    host: cpal::Host,
    app: AppHandle,
    output_device_name: Option<String>,
) -> Result<String, String> {
    // Verify both devices exist
    let mic_device = host
        .default_input_device()
        .ok_or_else(|| "Ingen mikrofon hittades".to_string())?;
    let output_device = match &output_device_name {
        Some(name) => find_output_device_by_name(name)?,
        None => host
            .default_output_device()
            .ok_or_else(|| "Ingen utgångsenhet hittades för systemljud".to_string())?,
    };

    let mic_config = mic_device
        .default_input_config()
        .map_err(|e| format!("Kunde inte öppna mikrofonen: {}", e))?;
    let output_config = output_device
        .default_output_config()
        .map_err(|e| format!("Kunde inte öppna utgångsenheten: {}", e))?;

    let mic_sample_rate = mic_config.sample_rate().0;
    let loopback_sample_rate = output_config.sample_rate().0;

    // WAV at mic sample rate
    let timestamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let path = std::env::temp_dir().join(format!("motesskribent_rec_{}.wav", timestamp));

    let spec = WavSpec {
        channels: 1,
        sample_rate: mic_sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let writer = WavWriter::create(&path, spec)
        .map_err(|e| format!("Kunde inte skapa inspelningsfil: {}", e))?;
    let writer: SharedWriter = Arc::new(Mutex::new(Some(writer)));

    let running = Arc::new(AtomicBool::new(true));
    let audio_level = Arc::new(AtomicU32::new(0u32));
    let device_name = match &output_device_name {
        Some(name) => format!("Mikrofon + {}", name),
        None => "Mikrofon + Systemljud".to_string(),
    };

    // Ring buffer capacity: ~2 seconds at mic sample rate
    let rb_capacity = (mic_sample_rate as usize) * 2;

    let mic_rb = HeapRb::<f32>::new(rb_capacity);
    let (mic_producer, mic_consumer) = mic_rb.split();

    let loopback_rb = HeapRb::<f32>::new(rb_capacity);
    let (loopback_producer, loopback_consumer) = loopback_rb.split();

    // Mic capture thread
    let running_mic = running.clone();
    let app_mic = app.clone();
    let mic_producer = Arc::new(Mutex::new(mic_producer));
    let mic_thread = Some(std::thread::spawn(move || {
        run_mic_capture_thread(mic_producer, running_mic, app_mic);
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
            audio_level_mix,
            mic_sample_rate,
            loopback_sample_rate,
        );
    }));

    spawn_tick_and_level_emitters(&running, &audio_level, &app);

    let return_name = device_name.clone();
    *guard = Some(RecordingHandle {
        running,
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

pub fn stop_recording(state: &RecorderState) -> Result<RecordingResult, String> {
    let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
    let mut handle = guard
        .take()
        .ok_or_else(|| "Ingen inspelning att stoppa".to_string())?;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn spawn_tick_and_level_emitters(
    running: &Arc<AtomicBool>,
    audio_level: &Arc<AtomicU32>,
    app: &AppHandle,
) {
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
) {
    let host = cpal::default_host();
    let device = match host.default_input_device() {
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
    let stream_config: cpal::StreamConfig = config.into();
    let running_cb = running.clone();
    let app_err = app.clone();

    let err_fn = move |err: cpal::StreamError| {
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
                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    mono_samples.push(frame.iter().sum::<f32>() / num_channels as f32);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
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
                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    let m: f32 = frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>()
                        / num_channels as f32;
                    mono_samples.push(m);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
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

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// ─── Loopback capture thread (WASAPI loopback on output device) ─────────────

fn run_loopback_capture_thread(
    producer: SharedProducer,
    running: Arc<AtomicBool>,
    app: AppHandle,
    output_device_name: Option<String>,
) {
    let device = match &output_device_name {
        Some(name) => match find_output_device_by_name(name) {
            Ok(d) => d,
            Err(e) => {
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
        },
        None => {
            let host = cpal::default_host();
            match host.default_output_device() {
                Some(d) => d,
                None => {
                    let _ = app.emit(
                        "recording-warning",
                        RecordingWarning {
                            message: "Ingen utgångsenhet hittades, fortsätter med bara mikrofon"
                                .to_string(),
                        },
                    );
                    while running.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                    return;
                }
            }
        }
    };

    let config = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            let _ = app.emit(
                "recording-warning",
                RecordingWarning {
                    message: format!(
                        "Kunde inte öppna systemljud: {}, fortsätter med bara mikrofon",
                        e
                    ),
                },
            );
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return;
        }
    };

    let sample_format = config.sample_format();
    let num_channels = config.channels() as usize;
    let stream_config: cpal::StreamConfig = config.into();
    let running_cb = running.clone();
    let app_err = app.clone();

    let err_fn = move |err: cpal::StreamError| {
        let _ = app_err.emit(
            "recording-warning",
            RecordingWarning {
                message: format!("Systemljudfel: {}", err),
            },
        );
    };

    // cpal 0.15 on WASAPI automatically sets AUDCLNT_STREAMFLAGS_LOOPBACK
    // when build_input_stream() is called on an output device.
    let stream = match sample_format {
        cpal::SampleFormat::F32 => device.build_input_stream(
            &stream_config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                if !running_cb.load(Ordering::Relaxed) {
                    return;
                }
                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    mono_samples.push(frame.iter().sum::<f32>() / num_channels as f32);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
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
                let mut mono_samples: Vec<f32> = Vec::with_capacity(data.len() / num_channels);
                for frame in data.chunks(num_channels) {
                    let m: f32 = frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>()
                        / num_channels as f32;
                    mono_samples.push(m);
                }
                if let Ok(mut prod) = producer.lock() {
                    prod.push_slice(&mono_samples);
                }
            },
            err_fn,
            None,
        ),
        format => {
            let _ = app.emit(
                "recording-warning",
                RecordingWarning {
                    message: format!(
                        "Systemljudformat {:?} stöds inte, fortsätter med bara mikrofon",
                        format
                    ),
                },
            );
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return;
        }
    };

    let stream = match stream {
        Ok(s) => s,
        Err(e) => {
            let _ = app.emit(
                "recording-warning",
                RecordingWarning {
                    message: format!(
                        "Kunde inte starta systemljudinspelning: {}, fortsätter med bara mikrofon",
                        e
                    ),
                },
            );
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            return;
        }
    };

    if let Err(e) = stream.play() {
        let _ = app.emit(
            "recording-warning",
            RecordingWarning {
                message: format!(
                    "Kunde inte starta systemljud: {}, fortsätter med bara mikrofon",
                    e
                ),
            },
        );
        while running.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        return;
    }

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

// ─── Mixer thread ────────────────────────────────────────────────────────────

fn run_mixer_thread(
    mic_consumer: SharedConsumer,
    loopback_consumer: SharedConsumer,
    writer: SharedWriter,
    running: Arc<AtomicBool>,
    audio_level: Arc<AtomicU32>,
    mic_sample_rate: u32,
    loopback_sample_rate: u32,
) {
    // Read chunk size: 20ms worth of mic samples
    let chunk_size = (mic_sample_rate as usize) / 50;
    let mut mic_buf = vec![0.0f32; chunk_size];
    let mut lb_buf_raw = vec![0.0f32; chunk_size * 2]; // oversized for different rates

    let needs_resample = mic_sample_rate != loopback_sample_rate;
    let lb_chunk_size = if needs_resample {
        ((chunk_size as f64) * (loopback_sample_rate as f64) / (mic_sample_rate as f64)).ceil()
            as usize
    } else {
        chunk_size
    };

    while running.load(Ordering::Relaxed) {
        // Read available mic samples
        let mic_read = if let Ok(mut cons) = mic_consumer.lock() {
            let available = cons.occupied_len();
            let to_read = available.min(chunk_size);
            if to_read > 0 {
                cons.pop_slice(&mut mic_buf[..to_read]);
                to_read
            } else {
                0
            }
        } else {
            0
        };

        // Read available loopback samples
        let lb_read = if let Ok(mut cons) = loopback_consumer.lock() {
            let available = cons.occupied_len();
            let to_read = available.min(lb_chunk_size);
            if to_read > 0 {
                if lb_buf_raw.len() < to_read {
                    lb_buf_raw.resize(to_read, 0.0);
                }
                cons.pop_slice(&mut lb_buf_raw[..to_read]);
                to_read
            } else {
                0
            }
        } else {
            0
        };

        // If no data from either source, sleep briefly and retry
        if mic_read == 0 && lb_read == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
            continue;
        }

        // Determine output length (based on mic data, or loopback if no mic)
        let output_len = if mic_read > 0 { mic_read } else { lb_read };

        // Resample loopback to match mic sample rate if needed
        let lb_resampled = if lb_read > 0 {
            if needs_resample {
                resample_linear(&lb_buf_raw[..lb_read], output_len)
            } else {
                let mut v = vec![0.0f32; output_len];
                let copy_len = lb_read.min(output_len);
                v[..copy_len].copy_from_slice(&lb_buf_raw[..copy_len]);
                v
            }
        } else {
            vec![0.0f32; output_len]
        };

        // Mix: mic * 0.7 + loopback * 0.7, clamped
        let mut sum_sq = 0.0f32;
        if let Ok(mut guard) = writer.lock() {
            if let Some(ref mut w) = *guard {
                for i in 0..output_len {
                    let mic_s = if i < mic_read { mic_buf[i] } else { 0.0 };
                    let lb_s = lb_resampled[i];
                    let mixed = (mic_s * 0.7 + lb_s * 0.7).clamp(-1.0, 1.0);
                    sum_sq += mixed * mixed;

                    let sample =
                        (mixed * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                    if w.write_sample(sample).is_err() {
                        break;
                    }
                }
            }
        }

        // Update audio level from mixed signal
        if output_len > 0 {
            let rms = (sum_sq / output_len as f32).sqrt();
            audio_level.store(rms.to_bits(), Ordering::Relaxed);
        }
    }
}
