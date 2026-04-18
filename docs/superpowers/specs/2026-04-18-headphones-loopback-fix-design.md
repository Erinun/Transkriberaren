# Fix Headphones Loopback + Manual Device Override

## Problem

When using headphones, the app captures microphone audio correctly but fails to capture the remote party's voice (meeting audio). This happens because `get_default_or_first_output()` uses a peak-meter check to decide between the console and communications default device. If there's no active audio at the moment of recording start (or a brief silence), it falls back to the console default (built-in speakers) instead of the communications device (headphones) where Teams/Zoom actually routes audio.

## Solution Overview

1. **Headphones mode fix**: Always prefer Windows communications device as loopback target — remove peak-meter check
2. **Speakers mode**: Keep current logic unchanged
3. **Fallback notification**: If no communications device exists, fall back to console default and show UI warning
4. **Manual override**: Expandable "Avancerat" section with output device dropdown

## Detailed Design

### 1. Backend: `get_default_or_first_output()` — Remove peak-meter check

**File**: `src-tauri/src/wasapi_loopback.rs` (lines 325-391)

**Current logic** (buggy):
```
1. Get console default (eConsole)
2. Get communications default (eCommunications)
3. If they differ: check peak meter on communications device
   - If peak > 0.001 → use communications
   - Else → use console default  ← THIS IS THE BUG
4. Use console default
```

**New logic**:
```
1. Get console default (eConsole)
2. Get communications default (eCommunications)
3. If they differ → always use communications default
   - Log: "Using communications device '{name}' (preferred for meeting audio)"
4. If no communications default → use console default
5. If neither → first active output device
```

Remove lines 346-360 (the peak meter check entirely). Replace with unconditional preference for communications device.

### 2. Backend: New `list_output_devices()` function + command

**File**: `src-tauri/src/wasapi_loopback.rs`

New public struct and function:

```rust
#[derive(Clone, serde::Serialize)]
pub struct OutputDeviceInfo {
    pub name: String,
    pub is_console_default: bool,
    pub is_communications_default: bool,
}

pub fn list_output_devices() -> Result<Vec<OutputDeviceInfo>, String> {
    // Enumerate all active render endpoints
    // Mark which ones are console/communications defaults
    // Return sorted list
}
```

**File**: `src-tauri/src/commands.rs`

New command:
```rust
#[tauri::command]
pub fn list_output_devices() -> Result<Vec<crate::wasapi_loopback::OutputDeviceInfo>, String> {
    crate::wasapi_loopback::list_output_devices()
}
```

**File**: `src-tauri/src/lib.rs`

Register the new command.

### 3. Backend: Extend `AudioModeInfo` with fallback flag

**File**: `src-tauri/src/wasapi_loopback.rs`

```rust
pub struct AudioModeInfo {
    pub detected_mode: String,
    pub has_microphone: bool,
    pub output_device_name: String,
    pub microphone_name: String,
    pub used_fallback: bool,  // NEW: true when communications device not found
}
```

In `detect_audio_mode()`:
- After calling `get_default_or_first_output()`, check if console and communications defaults differ
- If they're the same (or no communications default exists), set `used_fallback = true`
- This flag drives the UI warning

### 4. Backend: `start_recording()` accepts optional device override

**File**: `src-tauri/src/audio_capture.rs`

Change signature:
```rust
pub fn start_recording(
    state: &RecorderState,
    app: AppHandle,
    mode: String,
    output_device_override: Option<String>,  // NEW
) -> Result<String, String>
```

Logic:
- If `output_device_override` is `Some(name)` → use that device directly for loopback, skip auto-detection of output device
- Microphone selection still uses `detect_audio_mode()` logic (container ID matching in headphones mode)
- Log: "Using manually selected output device: '{name}'"

**File**: `src-tauri/src/commands.rs`

Update command signature:
```rust
#[tauri::command]
pub async fn start_recording(
    state: State<'_, RecorderState>,
    app: AppHandle,
    mode: String,
    output_device_override: Option<String>,  // NEW
) -> Result<String, String> {
    audio_capture::start_recording(&state, app, mode, output_device_override)
}
```

### 5. Frontend: Extend `useAudioMode.ts`

New state:
```typescript
outputDevices: OutputDeviceInfo[]        // all available output devices
manualOutputDevice: string | null        // user's manual selection (null = auto)
usedFallback: boolean                    // drives warning display
```

New function:
```typescript
setManualOutputDevice(name: string | null): void
```

- Persisted in localStorage: `"motesskribent-output-override:{deviceName}"` (keyed by auto-detected device for cleanup)
- When manual device is set, the `activeOutputDeviceName` reflects the manual choice
- Polling also calls `list_output_devices()` every 3 seconds to keep dropdown current

New interface:
```typescript
interface OutputDeviceInfo {
    name: string;
    is_console_default: boolean;
    is_communications_default: boolean;
}
```

### 6. Frontend: Extend `useRecorder.ts`

`start()` signature changes to accept optional override:
```typescript
start(mode: string, outputDeviceOverride?: string): Promise<void>
```

Passes `output_device_override` to Tauri `start_recording` command.

### 7. Frontend: RecordingView — "Avancerat" section + fallback warning

**File**: `app/src/components/RecordingView.tsx`

#### Fallback warning (always visible when applicable)

When `audioMode.usedFallback === true` and no manual override is set, show warning below device info:

```
⚠ Kunde inte hitta kommunikationsenhet — använder standardutgång.
  Kontrollera att rätt enhet är vald i Windows ljudinställningar.
```

Styled as yellow warning (same style as existing `recorder.warning`).

#### "Avancerat" expandable section (below device info)

- Default state: collapsed, showing "Avancerat ▸"
- Expanded state: shows dropdown with output devices
- Dropdown items:
  - "Automatiskt" (first, clears manual override)
  - All devices from `list_output_devices()`, each annotated:
    - `(standard)` if `is_console_default`
    - `(kommunikation)` if `is_communications_default`
    - Both tags if both are true
- Selected item shown with checkmark or highlight
- Manual selection persisted in localStorage

#### Recording start flow

When user clicks "Starta inspelning":
```typescript
const override = audioMode.manualOutputDevice;
await recorder.start(audioMode.activeMode, override ?? undefined);
```

## Logging

All device selection decisions must be logged:
- `"Communications default: '{name}', Console default: '{name}'"` — always
- `"Using communications device '{name}' (preferred for meeting audio)"` — when comms != console
- `"No separate communications device, using console default '{name}'"` — when same
- `"Using manually selected output device: '{name}'"` — when override active
- `"Fallback: no communications device found"` — when used_fallback=true

## What NOT to implement

- No dynamic device switching during active recording
- No "smart" active-audio detection (peak meter removed)
- No changes to Python pipeline
- No changes to audio level monitoring, pause/resume, or WAV format

## Files Changed

| File | Change |
|------|--------|
| `src-tauri/src/wasapi_loopback.rs` | Remove peak-meter check in `get_default_or_first_output()`, add `list_output_devices()`, extend `AudioModeInfo` with `used_fallback` |
| `src-tauri/src/audio_capture.rs` | Add `output_device_override` parameter to `start_recording()` |
| `src-tauri/src/commands.rs` | New `list_output_devices` command, update `start_recording` signature |
| `src-tauri/src/lib.rs` | Register `list_output_devices` command |
| `app/src/hooks/useAudioMode.ts` | Add device listing, manual override, fallback state |
| `app/src/hooks/useRecorder.ts` | Pass `output_device_override` to backend |
| `app/src/components/RecordingView.tsx` | Add "Avancerat" section with dropdown, fallback warning |

## Verification

1. **Test with headphones**: Connect headphones set as Windows communications device, start recording during a Teams/Zoom call → loopback should capture meeting audio
2. **Test with speakers**: Use speakers as default → behavior unchanged from before
3. **Test fallback**: Set console and communications to same device → `used_fallback=true`, warning shown
4. **Test manual override**: Select a specific device in dropdown → loopback uses that device
5. **Test persistence**: Set manual override, close/reopen app → override persists
6. **Verify logging**: Check Tauri logs for device selection reasons
7. **Build check**: `cargo tauri dev` compiles and runs without errors
