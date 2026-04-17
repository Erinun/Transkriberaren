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
    pub is_active: bool,
}

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

/// Find the default output device, falling back to the first available output device.
fn find_default_or_first_output_device(host: &cpal::Host) -> Result<cpal::Device, String> {
    if let Some(device) = host.default_output_device() {
        return Ok(device);
    }
    // Default unavailable — try the first output device we can find
    let mut output_devices = host
        .output_devices()
        .map_err(|e| format!("Kunde inte lista utgångsenheter: {}", e))?;
    output_devices
        .next()
        .ok_or_else(|| "Ingen utgångsenhet hittades".to_string())
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

    // Detect which output devices are currently playing audio
    let active_devices = crate::wasapi_loopback::detect_active_output_devices().unwrap_or_default();
    let active_names: std::collections::HashSet<String> = active_devices
        .iter()
        .filter(|d| d.peak_level > 0.001)
        .map(|d| d.name.clone())
        .collect();
    log::info!("Active output devices: {:?}", active_names);

    // Always include "default input"
    let default_input_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());

    devices.push(AudioDevice {
        id: "default_input".to_string(),
        name: "Standardmikrofon".to_string(),
        is_loopback: false,
        category: "input".to_string(),
        is_active: false,
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
                    is_active: false,
                });
            }
        }
    }

    // Enumerate ALL output devices for loopback and mixed options.
    // Use WASAPI names (from active_devices) to ensure consistency with loopback capture.
    let default_output_name = active_devices
        .iter()
        .find(|d| d.is_default)
        .map(|d| d.name.clone());
    log::info!("default_output_name (console): {:?}", default_output_name);

    let comms_default_name = active_devices
        .iter()
        .find(|d| d.is_communications_default && !d.is_default)
        .map(|d| d.name.clone());
    log::info!("comms_default_name: {:?}", comms_default_name);

    let output_names: Vec<String> = active_devices.iter().map(|d| d.name.clone()).collect();
    log::info!("Total output devices with names: {}", output_names.len());

    let has_default = default_output_name.is_some();

    if !output_names.is_empty() {
        // Check if default output is active
        let default_active = default_output_name
            .as_ref()
            .map(|n| active_names.contains(n.as_str()))
            .unwrap_or(false);
        let any_active = !active_names.is_empty();

        // Generic loopback (uses default output, or first available as fallback)
        devices.push(AudioDevice {
            id: "loopback".to_string(),
            name: "Systemljud (standard)".to_string(),
            is_loopback: true,
            category: "loopback".to_string(),
            is_active: default_active || any_active,
        });

        // Communications device loopback (if different from console default)
        if let Some(ref comms_name) = comms_default_name {
            let comms_active = active_names.contains(comms_name.as_str());
            devices.push(AudioDevice {
                id: format!("loopback:{}", comms_name),
                name: format!("Systemljud via {} (samtal)", comms_name),
                is_loopback: true,
                category: "loopback".to_string(),
                is_active: comms_active,
            });
        }

        // Per-output-device loopback entries (skip default and comms — already listed)
        for name in &output_names {
            let is_console_default = has_default && Some(name) == default_output_name.as_ref();
            let is_comms_default = comms_default_name.as_ref() == Some(name);
            if is_console_default || is_comms_default {
                continue;
            }
            let active = active_names.contains(name.as_str());
            devices.push(AudioDevice {
                id: format!("loopback:{}", name),
                name: format!("Systemljud via {}", name),
                is_loopback: true,
                category: "loopback".to_string(),
                is_active: active,
            });
        }

        // Generic mic + system
        devices.push(AudioDevice {
            id: "mic_and_system".to_string(),
            name: "Mikrofon + Systemljud (standard)".to_string(),
            is_loopback: false,
            category: "mixed".to_string(),
            is_active: default_active || any_active,
        });

        // Communications device mixed (if different from console default)
        if let Some(ref comms_name) = comms_default_name {
            let comms_active = active_names.contains(comms_name.as_str());
            devices.push(AudioDevice {
                id: format!("mic_and_output:{}", comms_name),
                name: format!("Mikrofon + {} (samtal)", comms_name),
                is_loopback: false,
                category: "mixed".to_string(),
                is_active: comms_active,
            });
        }

        // Per-output-device mic + output entries (skip default and comms — already listed)
        for name in &output_names {
            let is_console_default = has_default && Some(name) == default_output_name.as_ref();
            let is_comms_default = comms_default_name.as_ref() == Some(name);
            if is_console_default || is_comms_default {
                continue;
            }
            let active = active_names.contains(name.as_str());
            devices.push(AudioDevice {
                id: format!("mic_and_output:{}", name),
                name: format!("Mikrofon + {}", name),
                is_loopback: false,
                category: "mixed".to_string(),
                is_active: active,
            });
        }
    }

    log::info!(
        "Returning {} devices: {:?}",
        devices.len(),
        devices.iter().map(|d| format!("{}({}, active={})", d.id, d.category, d.is_active)).collect::<Vec<_>>()
    );
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
        DeviceSelection::Loopback => {
            start_recording_loopback_single(guard, app, None)
        }
        DeviceSelection::NamedLoopback(ref name) => {
            start_recording_loopback_single(guard, app, Some(name.clone()))
        }
        _ => {
            start_recording_single(guard, host, app, selection)
        }
    }
}

/// Start loopback-only recording using direct WASAPI (polling-based).
fn start_recording_loopback_single(
    mut guard: std::sync::MutexGuard<'_, Option<RecordingHandle>>,
    app: AppHandle,
    output_device_name: Option<String>,
) -> Result<String, String> {
    let sample_rate = crate::wasapi_loopback::get_output_device_sample_rate(
        output_device_name.as_deref(),
    )?;

    let device_name = match &output_device_name {
        Some(name) => format!("Systemljud via {}", name),
        None => "Systemljud (loopback)".to_string(),
    };

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
    let paused = Arc::new(AtomicBool::new(false));
    let paused_duration = Arc::new(Mutex::new(0.0f64));
    let pause_start: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));

    let writer_thread = writer.clone();
    let running_thread = running.clone();
    let audio_level_thread = audio_level.clone();
    let paused_thread = paused.clone();
    let return_name = device_name.clone();
    let lb_name = output_device_name.clone();
    let app_thread = app.clone();

    let mic_thread = Some(std::thread::spawn(move || {
        let capture = match crate::wasapi_loopback::WasapiLoopbackCapture::new(lb_name.as_deref())
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app_thread.emit(
                    "recording-error",
                    RecordingError { message: e },
                );
                return;
            }
        };

        if let Err(e) = capture.start() {
            let _ = app_thread.emit(
                "recording-error",
                RecordingError { message: e },
            );
            return;
        }

        log::info!("WASAPI loopback-only capture started (polling mode)");

        while running_thread.load(Ordering::Relaxed) {
            let is_paused = paused_thread.load(Ordering::Relaxed);

            let mut samples = Vec::new();
            match capture.capture_samples(&mut samples) {
                Ok(_) => {
                    if samples.is_empty() {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }

                    if !is_paused {
                        if let Ok(mut guard) = writer_thread.lock() {
                            if let Some(ref mut w) = *guard {
                                for &s in &samples {
                                    let sample = (s.clamp(-1.0, 1.0) * i16::MAX as f32)
                                        .clamp(i16::MIN as f32, i16::MAX as f32)
                                        as i16;
                                    if w.write_sample(sample).is_err() {
                                        break;
                                    }
                                }
                            }
                        }
                    }

                    // Audio level
                    if is_paused {
                        audio_level_thread.store(0u32, Ordering::Relaxed);
                    } else {
                        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
                        let rms = (sum_sq / samples.len() as f32).sqrt();
                        audio_level_thread.store(rms.to_bits(), Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    log::error!("Loopback capture error: {}", e);
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
            }
        }

        capture.stop();
        log::info!("WASAPI loopback-only capture ended");
    }));

    spawn_tick_and_level_emitters(&running, &paused, &paused_duration, &pause_start, &audio_level, &app);

    *guard = Some(RecordingHandle {
        running,
        paused,
        paused_duration,
        pause_start,
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

/// Start recording from a single device (mic or named input).
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
        // Loopback/Mixed handled by separate functions
        _ => unreachable!(),
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

    let paused = Arc::new(AtomicBool::new(false));
    let paused_duration = Arc::new(Mutex::new(0.0f64));
    let pause_start: Arc<Mutex<Option<std::time::Instant>>> = Arc::new(Mutex::new(None));

    let writer_thread = writer.clone();
    let running_thread = running.clone();
    let audio_level_thread = audio_level.clone();
    let paused_thread = paused.clone();
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
            // Loopback/Mixed handled by separate functions
            _ => unreachable!(),
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
        let audio_level_cb = audio_level_thread.clone();
        let paused_cb = paused_thread.clone();
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
                    let is_paused = paused_cb.load(Ordering::Relaxed);
                    if !is_paused {
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
                    }
                    if is_paused {
                        audio_level_cb.store(0u32, Ordering::Relaxed);
                    } else {
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
                        let is_paused = paused_cb.load(Ordering::Relaxed);
                        if !is_paused {
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
                        }
                        if is_paused {
                            audio_level_i16.store(0u32, Ordering::Relaxed);
                        } else {
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

    spawn_tick_and_level_emitters(&running, &paused, &paused_duration, &pause_start, &audio_level, &app);

    *guard = Some(RecordingHandle {
        running,
        paused,
        paused_duration,
        pause_start,
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
    // Verify mic exists
    let mic_device = host
        .default_input_device()
        .ok_or_else(|| "Ingen mikrofon hittades".to_string())?;

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

    log::info!("Mic capture started successfully on '{}'", mic_name);

    while running.load(Ordering::Relaxed) {
        std::thread::sleep(std::time::Duration::from_millis(100));
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

        // When paused: ringbuffers are drained above but we skip WAV writing
        if paused.load(Ordering::Relaxed) {
            audio_level.store(0u32, Ordering::Relaxed);
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

        // Write interleaved stereo: left=mic, right=system
        let mut sum_sq = 0.0f32;
        if let Ok(mut guard) = writer.lock() {
            if let Some(ref mut w) = *guard {
                for i in 0..output_len {
                    let mic_s = if i < mic_read { mic_buf[i] } else { 0.0 };
                    let lb_s = lb_resampled[i];

                    // Left channel: mic
                    let left = (mic_s.clamp(-1.0, 1.0) * i16::MAX as f32)
                        .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
                    // Right channel: system
                    let right = (lb_s.clamp(-1.0, 1.0) * i16::MAX as f32)
                        .clamp(i16::MIN as f32, i16::MAX as f32) as i16;

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
