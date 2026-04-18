# Simplified Audio Modes Design

Replace the complex device-selection UI (dropdown with 10+ devices in 3 categories) with two auto-detected modes: **Headphones** and **Speakers**. Both modes record stereo WAV (mic=left, system=right).

## Modes

### Headphones Mode
Activated when Windows reports the default output device's form factor as Headphones, Headset, or Earbuds (`PKEY_AudioEndpoint_FormFactor`).

- **Microphone**: Headset's own mic (matched by endpoint, fallback to default capture device)
- **System audio**: WASAPI loopback on the headphone output device
- **Result**: Stereo WAV — left=user's voice, right=remote participants' voices

### Speakers Mode
Activated when the default output device is anything other than headphones/headset.

- **Microphone**: Default capture device (built-in or external mic)
- **System audio**: WASAPI loopback on the default output device (speakers)
- **Result**: Stereo WAV — left=ambient mic, right=speaker playback

### Hybrid Detection
Auto-detection via `PKEY_AudioEndpoint_FormFactor` with a UI toggle so the user can override if detection is wrong. Override is persisted in localStorage **per default output device** (keyed by device name) so that switching between e.g. a USB DAC and laptop speakers doesn't carry over the wrong override.

The hook polls `detect_audio_mode()` every 3 seconds while idle (same cadence as the old device polling) and stops polling during active recording. If the detected mode changes (e.g. user plugs in headphones), the UI updates automatically. During recording, the loopback is locked to the device chosen at start time — device changes take effect on the next recording.

### No Microphone = No Recording
If no capture device is found, the start button is disabled and an error message is shown.

## Backend Changes (Rust)

### Remove
- `list_audio_devices()` command and the `AudioDevice` struct with category logic
- `detect_active_audio()` command and peak-meter polling (note: keep `detect_active_output_devices()` internal function — it is reused by `detect_audio_mode()` to check communications default activity)
- Device ID string parsing (`loopback:`, `mic_and_output:`, `input:`, etc.)
- All synthetic device categories (input/loopback/mixed)
- `start_recording_single()` and `start_recording_loopback_single()` paths (all recording goes through mixed mode)

### Add: `detect_audio_mode()` command

Returns:
```rust
struct AudioModeInfo {
    detected_mode: String,     // "headphones" or "speakers"
    has_microphone: bool,
    output_device_name: String,
    microphone_name: String,
}
```

Implementation:
1. Get default render endpoint via WASAPI (`eRender`, `eConsole`). Also check `eCommunications` — if it differs from console default and has active audio (peak level > 0), prefer the communications device (this is typically the headset in meeting scenarios).
2. Read `PKEY_AudioEndpoint_FormFactor` from property store. Log the raw value for diagnostics.
3. FormFactor values 3 (`Headphones`) and 4 (`Headset`) → `"headphones"`, everything else → `"speakers"`. Note: value 5 (`HeadsetMicrophone`) is an input-only FormFactor and will never appear on render endpoints. Value 8 (`UnknownFormFactor`) defaults to speakers since USB DACs and external audio interfaces commonly report this.
4. Get default capture endpoint — if none, `has_microphone: false`
5. In headphones mode: attempt to find the headset's own mic via `PKEY_Device_ContainerId` matching:
   a. Read the output device's ContainerId
   b. Enumerate all active capture devices and read their ContainerIds
   c. If exactly one capture device shares the same ContainerId → use that mic
   d. If multiple matches (common with integrated audio like Realtek where all endpoints share one ContainerId) or no matches → fall back to default capture device
   e. Log which mic was selected and why

### Simplify: `start_recording(mode)` command

Takes `mode: String` ("headphones" or "speakers") instead of `device_id: String`.

Internally:
- Always starts mixed recording (mic + loopback → stereo WAV)
- Selects devices based on mode:
  - `"headphones"`: headset mic + headphone loopback
  - `"speakers"`: default mic + default output loopback
- Reuses existing `run_mic_capture_thread` + `run_loopback_capture_thread` + `run_mixer_thread` architecture

### Keep unchanged
- `wasapi_loopback.rs` — direct WASAPI polling works well
- `stop_recording()`, `pause_recording()`, `resume_recording()`, `get_recording_status()` — unchanged
- Ring buffer + mixer + resampling architecture — unchanged
- Audio level monitoring — unchanged

## Frontend Changes (React/TypeScript)

### Remove
- `useAudioDevices.ts` — entire hook (device enumeration, 3s polling, localStorage device selection, auto-select logic)
- Device dropdown with 3 categories in RecordingView
- Info button explaining device categories
- "Uppdatera" refresh button
- Green active-device indicators

### Add: `useAudioMode.ts` hook

```typescript
interface AudioModeState {
  detectedMode: "headphones" | "speakers" | null;
  activeMode: "headphones" | "speakers";
  hasMicrophone: boolean;
  outputDeviceName: string;
  microphoneName: string;
  toggleMode: () => void;
}
```

- Calls `detect_audio_mode()` on mount and polls every 3 seconds while idle (stops during recording)
- Exposes detected mode + active mode (after user override)
- Persists user override in localStorage keyed by output device name: `"motesskribent-audio-mode-override:{deviceName}"`. Ignores stale overrides for devices no longer detected as default.
- `toggleMode()` flips between headphones/speakers
- Ignores/cleans up old `"motesskribent-audio-device"` localStorage key from previous version

### Modify: RecordingView idle state

Replace dropdown with:
- Mode indicator showing headphones or speakers icon
- Toggle switch to override detected mode
- Display selected mic name and output device name
- Start button (disabled if `!hasMicrophone` with error message)

### Modify: `useRecorder.ts`

- `start()` sends `mode: string` instead of `deviceId: string`
- Everything else unchanged

### Keep unchanged
- `useAudioLevel.ts` — unchanged
- `AudioLevelBars.tsx` — unchanged
- Recording/paused UI (timer, level bars, pause/stop buttons) — unchanged

## Python Pipeline

No changes. Recording format is identical: stereo WAV with mic on left channel, system audio on right channel. `channel_diarizer.py` handles this already.

## Files Changed

| File | Action |
|------|--------|
| `src-tauri/src/audio_capture.rs` | Major rewrite: remove device enumeration, add mode detection, simplify start_recording |
| `src-tauri/src/wasapi_loopback.rs` | Add `get_device_form_factor()` and `find_matching_capture_device()` helpers |
| `src-tauri/src/commands.rs` | New commands (`detect_audio_mode`), remove old ones (`list_audio_devices`, `detect_active_audio`) |
| `src-tauri/src/lib.rs` | Update registered commands |
| `app/src/hooks/useAudioDevices.ts` | **Delete** |
| `app/src/hooks/useAudioMode.ts` | **New file** |
| `app/src/hooks/useRecorder.ts` | Minor: mode instead of deviceId |
| `app/src/components/RecordingView.tsx` | Rewrite idle-state UI |

## Files Unchanged

| File | Reason |
|------|--------|
| `src-tauri/src/wasapi_loopback.rs` | Loopback capture unchanged; new helpers added but existing functions untouched |
| `app/src/hooks/useAudioLevel.ts` | Level monitoring unchanged |
| `app/src/components/AudioLevelBars.tsx` | Visualization unchanged |
| `src/motesskribent/**` | Pipeline unchanged, same stereo format |

## Known Limitations & Edge Cases

### Bluetooth devices
Bluetooth headphones report FormFactor inconsistently across drivers. Sony WH-1000XM series and AirPods typically report as `Headphones` (3), but cheaper Bluetooth adapters may report as `Speakers` (1) or `UnknownFormFactor` (8). The manual toggle covers these cases.

### USB DACs and external audio interfaces
These almost always report as `Speakers` (1) or `UnknownFormFactor` (8), even when headphones are physically plugged in. FormFactor is a static driver property, not a physical detection. The per-device override in localStorage lets users correct this once per device.

### Virtual audio devices
VB-Audio, Voicemeeter, and similar virtual audio drivers report FormFactor as `Speakers` (1). This is correct behavior — speakers mode will capture their loopback output.

### Integrated audio (Realtek etc.)
When a 3.5mm headset is plugged into a Realtek jack, Windows may or may not update the default endpoint's FormFactor depending on jack detection support. The ContainerId for all Realtek endpoints (speakers, headphone jack, built-in mic, line-in) is typically the same, so mic matching falls back to the default capture device. This is correct behavior for most laptop setups.

### Recording locked to start-time device
Once recording starts, the loopback captures from the output device that was default at start time. If the user switches output devices mid-recording (e.g. unplugs headphones), the loopback stream may go silent. This matches the previous behavior and is inherent to WASAPI loopback architecture.
