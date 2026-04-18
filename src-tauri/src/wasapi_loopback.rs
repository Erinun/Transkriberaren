//! Direct WASAPI loopback capture using polling-based approach.
//!
//! cpal 0.15.3 combines AUDCLNT_STREAMFLAGS_EVENTCALLBACK with LOOPBACK,
//! causing the callback to never fire on many Windows systems.
//! This module uses GetNextPacketSize polling instead.

use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::ptr;
use std::slice;

use windows::Win32::Devices::Properties;
use windows::Win32::Media::Audio;
use windows::Win32::Media::Multimedia;
use windows::Win32::System::Com;
use windows::Win32::System::Variant::{VT_LPWSTR, VT_UI4};

/// RAII guard for COM initialization on a thread.
struct ComGuard {
    needs_uninit: bool,
}

impl ComGuard {
    fn new() -> Self {
        unsafe {
            let hr = Com::CoInitializeEx(None, Com::COINIT_APARTMENTTHREADED);
            // S_OK or S_FALSE means we initialized, RPC_E_CHANGED_MODE is fine too
            let needs_uninit = hr.is_ok();
            ComGuard { needs_uninit }
        }
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.needs_uninit {
            unsafe {
                Com::CoUninitialize();
            }
        }
    }
}

/// Result of active device detection.
#[derive(Clone, serde::Serialize)]
pub struct ActiveOutputDevice {
    pub name: String,
    pub peak_level: f32,
    pub is_default: bool,
    pub is_communications_default: bool,
}

/// Polling-based WASAPI loopback capture.
pub struct WasapiLoopbackCapture {
    audio_client: Audio::IAudioClient,
    capture_client: Audio::IAudioCaptureClient,
    sample_rate: u32,
    channels: u16,
    bits_per_sample: u16,
    is_float: bool,
    device_name: String,
    _com_guard: ComGuard,
}

impl WasapiLoopbackCapture {
    /// Create a new loopback capture on the specified output device (or default).
    pub fn new(device_name: Option<&str>) -> Result<Self, String> {
        let com_guard = ComGuard::new();

        unsafe {
            let enumerator: Audio::IMMDeviceEnumerator =
                Com::CoCreateInstance(&Audio::MMDeviceEnumerator, None, Com::CLSCTX_ALL)
                    .map_err(|e| format!("Kunde inte skapa device enumerator: {}", e))?;

            let device = match device_name {
                Some(name) => find_output_device_by_name(&enumerator, name)?,
                None => get_default_or_first_output(&enumerator)?,
            };

            let device_friendly_name = get_device_name(&device).unwrap_or_else(|_| "okänd".into());
            log::info!("WASAPI loopback: using device '{}'", device_friendly_name);

            // Activate IAudioClient
            let audio_client: Audio::IAudioClient = device
                .Activate(Com::CLSCTX_ALL, None)
                .map_err(|e| format!("Kunde inte aktivera IAudioClient: {}", e))?;

            // Get the device's mix format (MUST use this for loopback)
            let mix_format_ptr = audio_client
                .GetMixFormat()
                .map_err(|e| format!("Kunde inte hämta mix-format: {}", e))?;

            let mix_format = &*mix_format_ptr;
            let sample_rate = mix_format.nSamplesPerSec;
            let channels = mix_format.nChannels;
            let bits_per_sample = mix_format.wBitsPerSample;

            // Determine if format is float
            // WAVE_FORMAT_EXTENSIBLE = 0xFFFE, WAVE_FORMAT_IEEE_FLOAT = 0x0003
            const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
            const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;

            let is_float = if mix_format.wFormatTag == WAVE_FORMAT_EXTENSIBLE {
                let ext = &*(mix_format_ptr as *const Audio::WAVEFORMATEXTENSIBLE);
                let sub_format: windows::core::GUID =
                    std::ptr::read_unaligned(std::ptr::addr_of!(ext.SubFormat));
                sub_format == Multimedia::KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
            } else {
                mix_format.wFormatTag == WAVE_FORMAT_IEEE_FLOAT
            };

            log::info!(
                "WASAPI loopback: format: {}Hz, {} ch, {} bits, float={}",
                sample_rate,
                channels,
                bits_per_sample,
                is_float,
            );

            // Initialize for loopback capture — NO EVENTCALLBACK flag!
            // Use 200ms buffer (in 100ns units)
            let buffer_duration: i64 = 2_000_000; // 200ms in 100ns units

            audio_client
                .Initialize(
                    Audio::AUDCLNT_SHAREMODE_SHARED,
                    Audio::AUDCLNT_STREAMFLAGS_LOOPBACK,
                    buffer_duration,
                    0,
                    mix_format_ptr,
                    None,
                )
                .map_err(|e| format!("Kunde inte initiera loopback: {}", e))?;

            // Get capture client
            let capture_client: Audio::IAudioCaptureClient = audio_client
                .GetService()
                .map_err(|e| format!("Kunde inte hämta IAudioCaptureClient: {}", e))?;

            // Free the mix format
            Com::CoTaskMemFree(Some(mix_format_ptr as *const _ as *const _));

            Ok(WasapiLoopbackCapture {
                audio_client,
                capture_client,
                sample_rate,
                channels,
                bits_per_sample,
                is_float,
                device_name: device_friendly_name,
                _com_guard: com_guard,
            })
        }
    }

    pub fn start(&self) -> Result<(), String> {
        unsafe {
            self.audio_client
                .Start()
                .map_err(|e| format!("Kunde inte starta loopback capture: {}", e))
        }
    }

    pub fn stop(&self) {
        unsafe {
            let _ = self.audio_client.Stop();
        }
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    #[allow(dead_code)]
    pub fn channels(&self) -> u16 {
        self.channels
    }

    pub fn device_name(&self) -> &str {
        &self.device_name
    }

    /// Read available samples, converting to mono f32. Returns the number of mono samples pushed.
    pub fn capture_samples(&self, output: &mut Vec<f32>) -> Result<usize, String> {
        let mut total_samples = 0usize;

        unsafe {
            loop {
                let packet_size = self
                    .capture_client
                    .GetNextPacketSize()
                    .map_err(|e| format!("GetNextPacketSize failed: {}", e))?;

                if packet_size == 0 {
                    break;
                }

                let mut buffer_ptr: *mut u8 = ptr::null_mut();
                let mut num_frames: u32 = 0;
                let mut flags: u32 = 0;

                self.capture_client
                    .GetBuffer(
                        &mut buffer_ptr,
                        &mut num_frames,
                        &mut flags,
                        None,
                        None,
                    )
                    .map_err(|e| format!("GetBuffer failed: {}", e))?;

                let is_silent = (flags & Audio::AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
                let ch = self.channels as usize;

                if is_silent || buffer_ptr.is_null() {
                    // Push silence
                    for _ in 0..num_frames {
                        output.push(0.0);
                    }
                } else if self.is_float && self.bits_per_sample == 32 {
                    // F32 format
                    let data =
                        slice::from_raw_parts(buffer_ptr as *const f32, num_frames as usize * ch);
                    for frame in data.chunks(ch) {
                        let mono: f32 = frame.iter().sum::<f32>() / ch as f32;
                        output.push(mono);
                    }
                } else if !self.is_float && self.bits_per_sample == 16 {
                    // I16 format
                    let data =
                        slice::from_raw_parts(buffer_ptr as *const i16, num_frames as usize * ch);
                    for frame in data.chunks(ch) {
                        let mono: f32 = frame.iter().map(|&s| s as f32 / 32768.0).sum::<f32>()
                            / ch as f32;
                        output.push(mono);
                    }
                } else if !self.is_float && self.bits_per_sample == 32 {
                    // I32 format
                    let data =
                        slice::from_raw_parts(buffer_ptr as *const i32, num_frames as usize * ch);
                    for frame in data.chunks(ch) {
                        let mono: f32 = frame
                            .iter()
                            .map(|&s| s as f32 / 2_147_483_648.0)
                            .sum::<f32>()
                            / ch as f32;
                        output.push(mono);
                    }
                } else if !self.is_float && self.bits_per_sample == 24 {
                    // 24-bit PCM packed as 3 bytes per sample
                    let byte_count = num_frames as usize * ch * 3;
                    let data = slice::from_raw_parts(buffer_ptr, byte_count);
                    for frame_idx in 0..num_frames as usize {
                        let mut sum = 0.0f32;
                        for c in 0..ch {
                            let offset = (frame_idx * ch + c) * 3;
                            let sample_i32 = ((data[offset] as i32)
                                | ((data[offset + 1] as i32) << 8)
                                | ((data[offset + 2] as i32) << 16))
                                << 8
                                >> 8; // sign-extend
                            sum += sample_i32 as f32 / 8_388_608.0;
                        }
                        output.push(sum / ch as f32);
                    }
                } else {
                    // Unknown format — push silence
                    log::warn!(
                        "Unknown loopback format: float={}, bits={}",
                        self.is_float,
                        self.bits_per_sample
                    );
                    for _ in 0..num_frames {
                        output.push(0.0);
                    }
                }

                total_samples += num_frames as usize;

                self.capture_client
                    .ReleaseBuffer(num_frames)
                    .map_err(|e| format!("ReleaseBuffer failed: {}", e))?;
            }
        }

        Ok(total_samples)
    }
}

// ─── Helper functions ────────────────────────────────────────────────────────

fn get_device_name(device: &Audio::IMMDevice) -> Result<String, String> {
    unsafe {
        let store = device
            .OpenPropertyStore(Com::STGM_READ)
            .map_err(|e| format!("OpenPropertyStore: {}", e))?;

        let prop_value = store
            .GetValue(
                &Properties::DEVPKEY_Device_FriendlyName as *const _ as *const _,
            )
            .map_err(|e| format!("GetValue: {}", e))?;

        let prop_variant = &prop_value.as_raw().Anonymous.Anonymous;
        if prop_variant.vt != VT_LPWSTR.0 {
            return Err("Not a string property".into());
        }

        let ptr_utf16 = *(&prop_variant.Anonymous as *const _ as *const *const u16);
        let mut len = 0isize;
        while *ptr_utf16.offset(len) != 0 {
            len += 1;
        }
        let name_slice = slice::from_raw_parts(ptr_utf16, len as usize);
        let name: OsString = OsStringExt::from_wide(name_slice);

        // Clear the PROPVARIANT
        drop(prop_value);

        name.into_string()
            .map_err(|_| "Invalid UTF-16 device name".into())
    }
}

fn get_default_or_first_output(
    enumerator: &Audio::IMMDeviceEnumerator,
) -> Result<Audio::IMMDevice, String> {
    unsafe {
        let console = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
            .ok();
        let comms = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eCommunications)
            .ok();

        // If console and communications defaults differ, always prefer communications
        // (Teams/Zoom route meeting audio to the communications device)
        if let (Some(ref con), Some(ref com)) = (&console, &comms) {
            let con_name = get_device_name(con).unwrap_or_default();
            let com_name = get_device_name(com).unwrap_or_default();
            if con_name != com_name {
                log::info!(
                    "Console default: '{}', Communications default: '{}'",
                    con_name,
                    com_name
                );
                log::info!(
                    "Using communications device '{}' (preferred for meeting audio)",
                    com_name
                );
                return Ok(com.clone());
            }
        }

        // Use console default
        if let Some(device) = console {
            return Ok(device);
        }

        // Fallback to first active output device
        let collection = enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints: {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount: {}", e))?;

        if count == 0 {
            return Err("Ingen utgångsenhet hittades".into());
        }

        collection
            .Item(0)
            .map_err(|e| format!("Item(0): {}", e))
    }
}

fn find_output_device_by_name(
    enumerator: &Audio::IMMDeviceEnumerator,
    target_name: &str,
) -> Result<Audio::IMMDevice, String> {
    unsafe {
        let collection = enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints: {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount: {}", e))?;

        for i in 0..count {
            if let Ok(device) = collection.Item(i) {
                if let Ok(name) = get_device_name(&device) {
                    if name == target_name {
                        return Ok(device);
                    }
                }
            }
        }

        Err(format!("Utgångsenhet '{}' hittades inte", target_name))
    }
}

/// Get the sample rate of an output device's mix format.
pub fn get_output_device_sample_rate(device_name: Option<&str>) -> Result<u32, String> {
    let _com = ComGuard::new();
    unsafe {
        let enumerator: Audio::IMMDeviceEnumerator =
            Com::CoCreateInstance(&Audio::MMDeviceEnumerator, None, Com::CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance: {}", e))?;

        let device = match device_name {
            Some(name) => find_output_device_by_name(&enumerator, name)?,
            None => get_default_or_first_output(&enumerator)?,
        };

        let audio_client: Audio::IAudioClient = device
            .Activate(Com::CLSCTX_ALL, None)
            .map_err(|e| format!("Activate: {}", e))?;

        let mix_format_ptr = audio_client
            .GetMixFormat()
            .map_err(|e| format!("GetMixFormat: {}", e))?;

        let sample_rate = (*mix_format_ptr).nSamplesPerSec;

        Com::CoTaskMemFree(Some(mix_format_ptr as *const _ as *const _));

        Ok(sample_rate)
    }
}

/// Detect which output devices are currently playing audio.
pub fn detect_active_output_devices() -> Result<Vec<ActiveOutputDevice>, String> {
    let _com = ComGuard::new();
    unsafe {
        let enumerator: Audio::IMMDeviceEnumerator =
            Com::CoCreateInstance(&Audio::MMDeviceEnumerator, None, Com::CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance: {}", e))?;

        // Get default output device names for comparison
        let default_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
            .ok()
            .and_then(|d| get_device_name(&d).ok());
        let comms_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eCommunications)
            .ok()
            .and_then(|d| get_device_name(&d).ok());

        log::info!("Default console output: {:?}", default_name);
        log::info!("Default communications output: {:?}", comms_name);

        let collection = enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints: {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount: {}", e))?;

        let mut result = Vec::new();

        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let name = match get_device_name(&device) {
                Ok(n) => n,
                Err(_) => continue,
            };

            // Get peak meter value
            let peak_level = match device.Activate::<Audio::Endpoints::IAudioMeterInformation>(
                Com::CLSCTX_ALL,
                None,
            ) {
                Ok(meter) => meter.GetPeakValue().unwrap_or(0.0),
                Err(_) => 0.0,
            };

            let is_default = default_name.as_deref() == Some(name.as_str());
            let is_communications_default = comms_name.as_deref() == Some(name.as_str());

            result.push(ActiveOutputDevice {
                name,
                peak_level,
                is_default,
                is_communications_default,
            });
        }

        Ok(result)
    }
}

// ─── Output device listing ─────────────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct OutputDeviceInfo {
    pub name: String,
    pub is_console_default: bool,
    pub is_communications_default: bool,
}

/// List all active output devices with default markers.
pub fn list_output_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    let _com = ComGuard::new();
    unsafe {
        let enumerator: Audio::IMMDeviceEnumerator =
            Com::CoCreateInstance(&Audio::MMDeviceEnumerator, None, Com::CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance: {}", e))?;

        let default_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
            .ok()
            .and_then(|d| get_device_name(&d).ok());
        let comms_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eCommunications)
            .ok()
            .and_then(|d| get_device_name(&d).ok());

        let collection = enumerator
            .EnumAudioEndpoints(Audio::eRender, Audio::DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints: {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount: {}", e))?;

        let mut result = Vec::new();
        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let name = match get_device_name(&device) {
                Ok(n) => n,
                Err(_) => continue,
            };
            result.push(OutputDeviceInfo {
                is_console_default: default_name.as_deref() == Some(name.as_str()),
                is_communications_default: comms_name.as_deref() == Some(name.as_str()),
                name,
            });
        }

        Ok(result)
    }
}

// ─── Simplified audio mode detection ────────────────────────────────────────

#[derive(Clone, serde::Serialize)]
pub struct AudioModeInfo {
    pub detected_mode: String,
    pub has_microphone: bool,
    pub output_device_name: String,
    pub microphone_name: String,
    pub used_fallback: bool,
}

/// PKEY_AudioEndpoint_FormFactor: {1da5d803-d492-4edd-8c23-e0c0ffee7f0e}, pid=0
const PKEY_AUDIOENDPOINT_FORMFACTOR: windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY =
    windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY {
        fmtid: windows::core::GUID::from_values(
            0x1da5d803,
            0xd492,
            0x4edd,
            [0x8c, 0x23, 0xe0, 0xc0, 0xff, 0xee, 0x7f, 0x0e],
        ),
        pid: 0,
    };

fn get_device_form_factor(device: &Audio::IMMDevice) -> Result<u32, String> {
    unsafe {
        let store = device
            .OpenPropertyStore(Com::STGM_READ)
            .map_err(|e| format!("OpenPropertyStore: {}", e))?;

        let prop_value = match store.GetValue(
            &PKEY_AUDIOENDPOINT_FORMFACTOR as *const _ as *const _,
        ) {
            Ok(v) => v,
            Err(_) => return Ok(1), // default to speakers
        };

        let prop_variant = &prop_value.as_raw().Anonymous.Anonymous;
        if prop_variant.vt != VT_UI4.0 {
            return Ok(1); // default to speakers
        }

        let form_factor = *(&prop_variant.Anonymous as *const _ as *const u32);
        Ok(form_factor)
    }
}

fn get_device_container_id(device: &Audio::IMMDevice) -> Result<windows::core::GUID, String> {
    unsafe {
        let store = device
            .OpenPropertyStore(Com::STGM_READ)
            .map_err(|e| format!("OpenPropertyStore: {}", e))?;

        let prop_value = store
            .GetValue(
                &Properties::DEVPKEY_Device_ContainerId as *const _ as *const _,
            )
            .map_err(|e| format!("GetValue ContainerId: {}", e))?;

        let prop_variant = &prop_value.as_raw().Anonymous.Anonymous;
        // VT_CLSID = 72
        if prop_variant.vt != 72 {
            return Err(format!(
                "ContainerId property has unexpected vt={}",
                prop_variant.vt
            ));
        }

        let guid_ptr =
            *(&prop_variant.Anonymous as *const _ as *const *const windows::core::GUID);
        let guid = *guid_ptr;
        Ok(guid)
    }
}

fn find_matching_capture_device(
    enumerator: &Audio::IMMDeviceEnumerator,
    target_container_id: &windows::core::GUID,
) -> Result<Option<String>, String> {
    unsafe {
        let collection = enumerator
            .EnumAudioEndpoints(Audio::eCapture, Audio::DEVICE_STATE_ACTIVE)
            .map_err(|e| format!("EnumAudioEndpoints(capture): {}", e))?;

        let count = collection
            .GetCount()
            .map_err(|e| format!("GetCount: {}", e))?;

        let mut matches = Vec::new();

        for i in 0..count {
            let device = match collection.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };

            let container_id = match get_device_container_id(&device) {
                Ok(id) => id,
                Err(_) => continue,
            };

            let name = get_device_name(&device).unwrap_or_else(|_| format!("capture-{}", i));

            if container_id == *target_container_id {
                log::info!(
                    "Capture device '{}' matches output container ID",
                    name
                );
                matches.push(name);
            }
        }

        log::info!(
            "Container ID matching: {} capture devices checked, {} matched",
            count,
            matches.len()
        );

        if matches.len() == 1 {
            Ok(Some(matches.remove(0)))
        } else {
            Ok(None)
        }
    }
}

pub fn detect_audio_mode() -> Result<AudioModeInfo, String> {
    let _com = ComGuard::new();

    unsafe {
        let enumerator: Audio::IMMDeviceEnumerator =
            Com::CoCreateInstance(&Audio::MMDeviceEnumerator, None, Com::CLSCTX_ALL)
                .map_err(|e| format!("CoCreateInstance: {}", e))?;

        let output_device = get_default_or_first_output(&enumerator)?;
        let output_device_name =
            get_device_name(&output_device).unwrap_or_else(|_| "okänd".into());
        let form_factor = get_device_form_factor(&output_device).unwrap_or(1);

        // FormFactor 3 = Headphones, 4 = Head Mounted Display
        let detected_mode = if form_factor == 3 || form_factor == 4 {
            "headphones".to_string()
        } else {
            "speakers".to_string()
        };

        // Check if we have a separate communications device
        let console_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eConsole)
            .ok()
            .and_then(|d| get_device_name(&d).ok());
        let comms_name = enumerator
            .GetDefaultAudioEndpoint(Audio::eRender, Audio::eCommunications)
            .ok()
            .and_then(|d| get_device_name(&d).ok());
        let used_fallback = match (&console_name, &comms_name) {
            (Some(con), Some(com)) => con == com,
            (_, None) => true,
            _ => false,
        };
        if used_fallback {
            log::info!(
                "No separate communications device, using console default '{}'",
                output_device_name
            );
        }

        // Check for default capture device (microphone)
        let default_mic = enumerator
            .GetDefaultAudioEndpoint(Audio::eCapture, Audio::eConsole)
            .ok();

        let default_mic = match default_mic {
            Some(mic) => mic,
            None => {
                log::info!(
                    "Audio mode detected: {} (form_factor={}), mic='(none)', output='{}'",
                    detected_mode,
                    form_factor,
                    output_device_name
                );
                return Ok(AudioModeInfo {
                    detected_mode,
                    has_microphone: false,
                    output_device_name,
                    microphone_name: "".into(),
                    used_fallback,
                });
            }
        };

        let default_mic_name =
            get_device_name(&default_mic).unwrap_or_else(|_| "okänd mikrofon".into());

        let microphone_name = if detected_mode == "headphones" {
            // Try to find a capture device with the same container ID as the output device
            match get_device_container_id(&output_device) {
                Ok(container_id) => {
                    match find_matching_capture_device(&enumerator, &container_id) {
                        Ok(Some(matched_name)) => {
                            log::info!(
                                "Headphones mode: matched mic '{}' via container ID",
                                matched_name
                            );
                            matched_name
                        }
                        _ => {
                            log::info!(
                                "Headphones mode: no container ID match, using default mic '{}'",
                                default_mic_name
                            );
                            default_mic_name.clone()
                        }
                    }
                }
                Err(e) => {
                    log::info!(
                        "Headphones mode: couldn't get container ID ({}), using default mic '{}'",
                        e,
                        default_mic_name
                    );
                    default_mic_name.clone()
                }
            }
        } else {
            default_mic_name.clone()
        };

        log::info!(
            "Audio mode detected: {} (form_factor={}), mic='{}', output='{}'",
            detected_mode,
            form_factor,
            microphone_name,
            output_device_name
        );

        Ok(AudioModeInfo {
            detected_mode,
            has_microphone: true,
            output_device_name,
            microphone_name,
            used_fallback,
        })
    }
}
