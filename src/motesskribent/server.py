"""Persistent sidecar-server för GUI-kommunikation via NDJSON över stdin/stdout."""

from __future__ import annotations

import json
import logging
import sys
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path

logger = logging.getLogger(__name__)

# Swedish step names (shared with cli.py _run_json_ipc)
_STEPS_SV = {
    "preprocessing": "Förbehandlar ljud",
    "diarization": "Identifierar talare",
    "transcription": "Transkriberar",
    "formatting": "Formaterar output",
}


def _emit(data: dict) -> None:
    """Write a single JSON line to stdout."""
    print(json.dumps(data, ensure_ascii=False), flush=True)


def _handle_ping(request_id: str) -> None:
    _emit({"request_id": request_id, "type": "pong"})


def _handle_warmup(request_id: str, config: dict) -> None:
    """Load models into memory. Parallelizes whisper + diarize loading."""
    model = config.get("model", "KBLab/kb-whisper-small")
    num_speakers = config.get("num_speakers")
    need_diarizer = num_speakers is None or num_speakers > 1

    _emit({
        "request_id": request_id,
        "type": "progress",
        "stage": "warmup",
        "percent": 0,
        "message": "Laddar modeller...",
    })

    def load_transcriber():
        from motesskribent.transcription.transcriber import _get_model
        _get_model(model)

    def load_diarizer():
        from motesskribent.diarization.diarizer import _warmup_models
        _warmup_models()

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(load_transcriber)]
        if need_diarizer:
            futures.append(pool.submit(load_diarizer))
        wait(futures)

        # Check for errors — transcriber is required, diarizer is optional
        transcriber_future = futures[0]
        transcriber_future.result()  # Re-raise if transcriber failed

        diarizer_ok = True
        if need_diarizer and len(futures) > 1:
            diarizer_future = futures[1]
            try:
                diarizer_future.result()
            except Exception as e:
                diarizer_ok = False
                logger.warning("Diariser-modell kunde inte laddas (fortsätter ändå): %s", e)
        elif not need_diarizer:
            diarizer_ok = True

    _emit({
        "request_id": request_id,
        "type": "progress",
        "stage": "warmup",
        "percent": 100,
        "message": "Modeller laddade",
        "diarization_available": diarizer_ok,
    })


def _handle_transcribe(request_id: str, audio_path: str, config: dict) -> None:
    """Run the full pipeline, emitting progress events."""
    from motesskribent.pipeline import PipelineConfig, run_pipeline

    pipeline_config = PipelineConfig(
        model_path=config.get("model", "KBLab/kb-whisper-small"),
        num_speakers=config.get("num_speakers"),
        output_dir=Path(config.get("output_dir", "output")),
        output_formats=config.get("formats", ["markdown", "json"]),
        initial_prompt=config.get("prompt"),
        vad_enabled=config.get("vad_enabled", True),
        speed_profile=config.get("speed_profile", "balanced"),
        audio_source=config.get("audio_source"),
    )

    def on_progress(step: str, fraction: float):
        _emit({
            "request_id": request_id,
            "type": "progress",
            "stage": step,
            "percent": round(fraction * 100),
            "message": _STEPS_SV.get(step, step),
        })

    result = run_pipeline(Path(audio_path), pipeline_config, progress_callback=on_progress)

    _emit({
        "request_id": request_id,
        "type": "result",
        "success": True,
        "output_files": [str(f) for f in result.output_files],
        "md_content": result.md_content,
        "warnings": result.warnings,
        "model_name": str(pipeline_config.model_path),
        "word_count": sum(len(seg.text.split()) for seg in result.segments),
        "segments": [
            {
                "start": seg.start,
                "end": seg.end,
                "speaker_id": seg.speaker_id,
                "speaker_label": seg.speaker_label,
                "text": seg.text,
            }
            for seg in result.segments
        ],
        "summary": {
            "total_duration": result.total_duration,
            "speech_duration": result.speech_duration,
            "processing_time": result.processing_time,
            "num_speakers": result.num_speakers,
            "num_segments": len(result.segments),
        },
    })


def run_server() -> None:
    """Main server loop: read NDJSON commands from stdin, dispatch, respond on stdout."""
    # Suppress all logging to stdout (we use it for IPC)
    logging.basicConfig(
        level=logging.WARNING,
        stream=sys.stderr,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    _emit({"type": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            logger.warning("Ogiltigt JSON: %s", line)
            continue

        request_id = msg.get("request_id", "")
        command = msg.get("command", "")

        try:
            if command == "ping":
                _handle_ping(request_id)
            elif command == "warmup":
                _handle_warmup(request_id, msg.get("config", {}))
            elif command == "transcribe":
                _handle_transcribe(
                    request_id,
                    msg.get("audio_path", ""),
                    msg.get("config", {}),
                )
            elif command == "shutdown":
                _emit({"request_id": request_id, "type": "end"})
                break
            else:
                _emit({
                    "request_id": request_id,
                    "type": "error",
                    "message": f"Okänt kommando: {command}",
                    "stage": "server",
                })
        except Exception as e:
            _emit({
                "request_id": request_id,
                "type": "error",
                "message": str(e),
                "stage": command or "server",
            })
        finally:
            _emit({"request_id": request_id, "type": "end"})
