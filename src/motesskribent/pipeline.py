"""Huvudpipeline som orkestrerar hela bearbetningsflödet."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from motesskribent.transcription.transcriber import TranscribedSegment

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, float], None]


@dataclass
class PipelineConfig:
    """Konfiguration för transkriberingspipelinen."""
    model_path: Path | str = "KBLab/kb-whisper-small"
    language: str = "sv"
    compute_type: str = "int8"
    cpu_threads: int | None = None
    beam_size: int = 5
    vad_enabled: bool = True
    num_speakers: int | None = None
    min_speakers: int = 2
    max_speakers: int = 10
    hf_token: str | None = None
    output_dir: Path = field(default_factory=lambda: Path("output"))
    output_formats: list[str] = field(default_factory=lambda: ["markdown", "json"])
    include_word_timestamps: bool = False
    initial_prompt: str | None = None


@dataclass
class PipelineResult:
    """Resultat från hela pipelinen."""
    output_files: list[Path]
    segments: list[TranscribedSegment]
    num_speakers: int
    total_duration: float
    speech_duration: float
    processing_time: float
    processing_breakdown: dict[str, float]


def _assign_speakers(
    transcription_segments: list[TranscribedSegment],
    diarization_segments: list,
) -> list[TranscribedSegment]:
    """Matcha talare till transkriberingssegment via tidsöverlapp.

    För varje TranscribedSegment: hitta SpeakerSegment med störst tidsöverlapp.
    Om inget överlapp finns sätts speaker_label till "Okänd talare".
    """
    for seg in transcription_segments:
        best_overlap = 0.0
        best_speaker_id = None
        best_speaker_label = "Okänd talare"

        for d_seg in diarization_segments:
            overlap = min(seg.end, d_seg.end) - max(seg.start, d_seg.start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker_id = d_seg.speaker_id
                best_speaker_label = d_seg.speaker_label or d_seg.speaker_id

        seg.speaker_id = best_speaker_id
        seg.speaker_label = best_speaker_label

    return transcription_segments


def run_pipeline(
    audio_path: Path | str,
    config: PipelineConfig,
    progress_callback: ProgressCallback | None = None,
) -> PipelineResult:
    """Kör hela transkriberingspipelinen.

    Steg:
    1. Förbehandla ljud (konvertering + VAD-statistik)
    2. Talarseparering (diarisering)
    3. Transkribering
    4. Matcha talare till segment
    5. Merga korta segment
    6. Formatera och spara output

    Args:
        audio_path: Sökväg till ljudfil.
        config: PipelineConfig med alla inställningar.
        progress_callback: Callback(steg, andel) för progress.

    Returns:
        PipelineResult med alla resultat.
    """
    from datetime import datetime

    from motesskribent.audio.preprocessor import preprocess_audio
    from motesskribent.output.formatter import merge_short_segments, to_json, to_markdown

    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    config.output_dir = Path(config.output_dir)
    config.output_dir.mkdir(parents=True, exist_ok=True)

    def _progress(step: str, fraction: float):
        if progress_callback:
            progress_callback(step, fraction)

    pipeline_start = time.perf_counter()
    breakdown: dict[str, float] = {}

    # 1. Förbehandling
    t0 = time.perf_counter()
    preprocessed = preprocess_audio(audio_path, config.output_dir / "temp")
    breakdown["preprocessing"] = time.perf_counter() - t0
    _progress("preprocessing", 0.05)

    # 2. Diarisering
    diarization_segments = []
    num_speakers = 0
    skip_diarization = config.num_speakers is not None and config.num_speakers <= 1
    t0 = time.perf_counter()

    if skip_diarization:
        logger.info("Hoppar över diarisering (num_speakers=%s)", config.num_speakers)
        num_speakers = max(config.num_speakers, 1)
    else:
        try:
            from motesskribent.diarization.diarizer import diarize

            diar_result = diarize(
                preprocessed.audio_path,
                num_speakers=config.num_speakers,
                min_speakers=config.min_speakers,
                max_speakers=config.max_speakers,
                hf_token=config.hf_token,
            )
            diarization_segments = diar_result.segments
            num_speakers = diar_result.num_speakers
        except Exception:
            logger.warning("Diarisering misslyckades, fortsätter utan talare", exc_info=True)

    breakdown["diarization"] = time.perf_counter() - t0
    _progress("diarization", 0.35)

    # 3. Transkribering
    t0 = time.perf_counter()
    from motesskribent.transcription.transcriber import transcribe

    trans_result = transcribe(
        preprocessed.audio_path,
        model_path=config.model_path,
        language=config.language,
        beam_size=config.beam_size,
        cpu_threads=config.cpu_threads,
        compute_type=config.compute_type,
        word_timestamps=config.include_word_timestamps,
        initial_prompt=config.initial_prompt,
        vad_filter=config.vad_enabled,
    )
    breakdown["transcription"] = time.perf_counter() - t0
    _progress("transcription", 0.90)

    # 4. Matcha talare
    segments = _assign_speakers(trans_result.segments, diarization_segments)

    if skip_diarization:
        for seg in segments:
            seg.speaker_id = "SPEAKER_00"
            seg.speaker_label = "Talare 1"

    # 5. Merga korta segment
    segments = merge_short_segments(segments)

    # 6. Formatera och spara
    t0 = time.perf_counter()
    metadata = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "duration": preprocessed.duration_original,
        "num_speakers": num_speakers,
        "processing_time": time.perf_counter() - pipeline_start,
        "model_name": str(config.model_path),
        "version": "0.1.0",
    }

    output_files: list[Path] = []
    stem = audio_path.stem

    if "markdown" in config.output_formats:
        md_content = to_markdown(segments, metadata)
        md_path = config.output_dir / f"{stem}.md"
        md_path.write_text(md_content, encoding="utf-8")
        output_files.append(md_path)
        logger.info("Sparade markdown: %s", md_path)

    if "json" in config.output_formats:
        json_content = to_json(segments, metadata, config.include_word_timestamps)
        json_path = config.output_dir / f"{stem}.json"
        json_path.write_text(json_content, encoding="utf-8")
        output_files.append(json_path)
        logger.info("Sparade JSON: %s", json_path)

    breakdown["formatting"] = time.perf_counter() - t0
    _progress("formatting", 1.0)

    total_time = time.perf_counter() - pipeline_start

    logger.info("Pipeline klar: %.1f sek totalt", total_time)

    return PipelineResult(
        output_files=output_files,
        segments=segments,
        num_speakers=num_speakers,
        total_duration=preprocessed.duration_original,
        speech_duration=preprocessed.duration_speech,
        processing_time=total_time,
        processing_breakdown=breakdown,
    )
