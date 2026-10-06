# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

MötesSkribent — local meeting transcription with speaker diarization. CPU-only, no network, GDPR-safe. Phase 1 is a Python CLI pipeline (complete); Phase 2 is a Tauri desktop app (MVP).

## Commands

```bash
# Install (dev mode)
pip install -e .

# PyTorch CPU (must use CPU index, never main PyPI)
pip install --index-url https://download.pytorch.org/whl/cpu torch torchaudio

# Run all unit tests (no models needed)
pytest tests/ -m "not integration" -v

# Run a single test file or class
pytest tests/test_formatter.py -v
pytest tests/test_pipeline.py::TestAssignSpeakers -v

# Standalone integration tests (require real audio + downloaded models)
python tests/run_transcriber_test.py <audio.wav>
python tests/run_diarizer_test.py <audio.wav> --num-speakers 3

# CLI
motesskribent transkribera <audio.wav> --talare 2
motesskribent transkribera <audio.wav> --json-ipc  # JSON-IPC mode for GUI
motesskribent modeller
motesskribent info

# Tauri desktop app (requires Rust toolchain + Node.js)
# First time only: install frontend dependencies
cd C:\Dev\Motesskribent\app
npm install

# Start dev mode (starts both Vite frontend + Rust backend)
# PowerShell: add cargo to PATH first if needed
$env:Path += ";$env:USERPROFILE\.cargo\bin"
cd C:\Dev\Motesskribent\src-tauri
cargo tauri dev

# Persistent sidecar server (used internally by GUI, not called directly)
motesskribent serve
```

No linter or formatter is configured.

## Architecture

**Pipeline flow** (`run_pipeline` in `pipeline.py`):

```
audio file → preprocessor → diarizer → transcriber → _assign_speakers → merge_short_segments → formatter → .md/.json
```

1. **preprocessor** loads audio with `soundfile.read()`, converts to mono, resamples to 16kHz with `torchaudio.functional.resample()`, runs Silero VAD for speech/silence statistics. Output: `PreprocessedAudio` with path to converted WAV.

2. **diarizer** runs the `diarize` library (Silero VAD + WeSpeaker ONNX + spectral clustering) on CPU, no HF token. Merges short same-speaker segments, assigns labels ("Talare 1", "Talare 2") by order of first appearance. Output: `DiarizationResult` with `SpeakerSegment` list. Fails gracefully — pipeline continues without speakers. Stereo recordings (left=mic, right=system) skip it: each channel is transcribed separately and `channel_diarizer.merge_channel_transcriptions` labels mic=Talare 1, system=Talare 2.

3. **transcription provider** (`transcription/providers/`) is selected by `PipelineConfig.provider` (default `"kb-whisper"`). Default is `"pianissimo"` (`PianissimoProvider`: KlangAI/pianissimo-sv-onnx int8 via onnx-asr + Silero VAD, token timestamps → words → sentence-sized segments). `KbWhisperProvider` wraps `transcriber.transcribe()` (faster-whisper with KB-Whisper CTranslate2 models) and is the fallback: if the chosen engine fails to load or run, `run_pipeline` reruns transcription with KB-Whisper and adds a Swedish warning; `PipelineResult.engine` / IPC `engine` tell which engine was used. New engines subclass `TranscriptionProvider` and register in `registry.py`. Output: `TranscriptionResult` with `TranscribedSegment` list.

4. **`_assign_speakers`** matches each transcription segment to the diarization segment with maximum time overlap.

5. **formatter** merges consecutive same-speaker segments (gap < 2s), generates Swedish Markdown protocol and/or JSON.

**Key dataclasses** flow through the pipeline: `TranscribedWord` → `TranscribedSegment` → `TranscriptionResult` (transcriber), `SpeakerSegment` → `DiarizationResult` (diarizer), `PreprocessedAudio` (preprocessor), `PipelineConfig`/`PipelineResult` (pipeline).

Both transcriber and diarizer cache their models at module level to avoid reloading.

## Gotchas

- **`model.transcribe()` returns a generator** — must consume exactly once. Current code iterates and builds a list.
- **faster-whisper word field is `probability`**, mapped to `TranscribedWord.confidence` in our dataclass.
- **Do not use `torchaudio.load()`** on Windows — torchaudio 2.10+ requires torchcodec + FFmpeg DLLs. Use `soundfile.read()` for loading; only use `torchaudio.functional.resample()` (pure torch, no backend needed).
- **Pianissimo models are bundled as plain directories** `models/pianissimo-sv-onnx/` and `models/silero-vad-onnx/` (downloaded by `scripts/download_models.py` through onnx-asr), found via `MOTESSKRIBENT_MODELS_DIR` or `HF_HOME`. onnx-asr ≥0.12 excludes onnxruntime 1.24.1/1.25.x/1.26.0; requires Python ≥3.11.
- **Startup warmup engine** is read by Rust from `<app_config_dir>/transcription_engine.txt` (written by the `set_transcription_engine` command when the setting changes), because settings otherwise live only in frontend `localStorage`.
- **Tests patch `transcriber.transcribe` as a module attribute** — providers must call it via `transcriber.transcribe(...)`, not a `from ... import transcribe` binding. `tests/test_transcription_contract.py` locks the exact arguments the pipeline sends to KB-Whisper.
- **Segment merging exists in two places**: `_merge_segments` in diarizer.py (SpeakerSegment) and `merge_short_segments` in formatter.py (TranscribedSegment). Different dataclass types, similar logic.

## Conventions

- src-layout: all source under `src/motesskribent/`
- All user-facing strings in Swedish; default language "sv", default model "KBLab/kb-whisper-base"
- Integration tests use `@pytest.mark.skipif` when fixtures/models are missing
- Test audio generated synthetically with numpy+soundfile in `tmp_path` fixtures
- CLI uses Click groups + Rich progress/tables
- CLI `--json-ipc` flag outputs JSON progress to stdout (used by Tauri sidecar)

## Tauri App (Phase 2)

**Project structure:**
- `app/` — React + TypeScript + Vite frontend (port 1420)
- `src-tauri/` — Rust backend with Tauri v2
- Python pipeline runs as a persistent sidecar process (`motesskribent serve`)

**Frontend views:** TranscribeView → ProcessingView → ResultView + SettingsView + RecordingView (placeholder)

**IPC flow (persistent sidecar):**
1. App startup: `SidecarManager` spawns `python -m motesskribent serve` and sends `warmup` command
2. Frontend calls `invoke("run_transcription", {audioPath, config})`
3. Rust sends `transcribe` command via stdin (NDJSON with `request_id`)
4. Python emits JSON lines to stdout: `progress` / `result` / `error` / `end`
5. Rust background reader routes events by `request_id`, emits Tauri `pipeline-event`
6. React `usePipeline` hook listens to events and updates UI
7. Fallback: if persistent sidecar fails, falls back to one-shot `--json-ipc` mode

**Performance optimizations:**
- Persistent sidecar keeps models in memory between transcriptions
- Parallel model loading (transcription provider + diarize) during warmup via ThreadPoolExecutor
- Skip diarization when `num_speakers <= 1` (saves ~10-25s)
