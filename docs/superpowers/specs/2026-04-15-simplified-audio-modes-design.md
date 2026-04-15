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
Auto-detection via `PKEY_AudioEndpoint_FormFactor` with a UI toggle so the user can override if detection is wrong. Override is persisted in localStorage.

### No Microphone = No Recording
If no capture device is found, the start button is disabled and an error message is shown.

## Backend Changes (Rust)

### Remove
- `list_audio_devices()` command and the `AudioDevice` struct with category logic
- `detect_active_audio()` command and peak-meter polling
- Device ID string parsing (`loopback:`, `mic_and_output:`, `input:`, etc.)
- All synthetic device categories (input/loopback/mixed)

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
1. Get default render endpoint via WASAPI (`eRender`, `eMultimedia`)
2. Read `PKEY_AudioEndpoint_FormFactor` from property store
3. FormFactor values 3 (Headphones), 5 (Headset), 8 (UnknownDigitalPassthrough, often BT earbuds) → `"headphones"`, everything else → `"speakers"`
4. Get default capture endpoint — if none, `has_microphone: false`
5. In headphones mode: attempt to find the headset's own mic by matching device interface path; fall back to default capture

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

- Calls `detect_audio_mode()` on mount
- Exposes detected mode + active mode (after user override)
- Persists user override in localStorage key `"motesskribent-audio-mode"`
- `toggleMode()` flips between headphones/speakers

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
| `src-tauri/src/commands.rs` | New commands, remove old ones |
| `src-tauri/src/lib.rs` | Update registered commands |
| `app/src/hooks/useAudioDevices.ts` | **Delete** |
| `app/src/hooks/useAudioMode.ts` | **New file** |
| `app/src/hooks/useRecorder.ts` | Minor: mode instead of deviceId |
| `app/src/components/RecordingView.tsx` | Rewrite idle-state UI |

## Files Unchanged

| File | Reason |
|------|--------|
| `src-tauri/src/wasapi_loopback.rs` | Loopback capture still needed |
| `app/src/hooks/useAudioLevel.ts` | Level monitoring unchanged |
| `app/src/components/AudioLevelBars.tsx` | Visualization unchanged |
| `src/motesskribent/**` | Pipeline unchanged, same stereo format |
