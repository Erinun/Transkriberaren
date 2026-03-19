"""Huvudpipeline som orkestrerar hela bearbetningsflödet."""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from motesskribent.transcription.transcriber import TranscribedSegment

logger = logging.getLogger(__name__)

ProgressCallback = Callable[[str, float], None]


SPEED_PROFILES = {
    "fast": {"beam_size": 1, "batch_size": 24},
    "balanced": {"beam_size": 1, "batch_size": 16},
    "quality": {"beam_size": 5, "batch_size": 8},
}


@dataclass
class PipelineConfig:
    """Konfiguration för transkriberingspipelinen."""
    model_path: Path | str = "KBLab/kb-whisper-small"
    language: str = "sv"
    compute_type: str = "int8"
    cpu_threads: int | None = None
    beam_size: int = 1
    batch_size: int = 16
    vad_enabled: bool = True
    num_speakers: int | None = None
    min_speakers: int = 2
    max_speakers: int = 10
    output_dir: Path = field(default_factory=lambda: Path("output"))
    output_formats: list[str] = field(default_factory=lambda: ["markdown", "json"])
    include_word_timestamps: bool = False
    initial_prompt: str | None = None
    speed_profile: str = "balanced"
    audio_source: str | None = None


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
    md_content: str | None = None
    warnings: list[str] = field(default_factory=list)


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
    from motesskribent.output.formatter import merge_short_segments, to_docx, to_json, to_markdown

    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    # Resolve speed profile → beam_size / batch_size
    if config.speed_profile in SPEED_PROFILES:
        profile = SPEED_PROFILES[config.speed_profile]
        config.beam_size = profile["beam_size"]
        config.batch_size = profile["batch_size"]

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

    # 2+3. Diarisering och transkribering parallellt
    diarization_segments = []
    num_speakers = 0
    diarization_failed = False
    skip_diarization = config.num_speakers is not None and config.num_speakers <= 1
    warnings: list[str] = []
    trans_result = None

    def _run_diarization():
        nonlocal diarization_segments, num_speakers, diarization_failed
        t = time.perf_counter()
        if skip_diarization:
            logger.info("Hoppar över diarisering (num_speakers=%s)", config.num_speakers)
            num_speakers = max(config.num_speakers, 1)
            return 0.0
        try:
            from motesskribent.diarization.diarizer import diarize
            diar_result = diarize(
                preprocessed.audio_path,
                num_speakers=config.num_speakers,
                min_speakers=config.min_speakers,
                max_speakers=config.max_speakers,
            )
            diarization_segments = diar_result.segments
            num_speakers = diar_result.num_speakers
        except Exception:
            logger.warning("Diarisering misslyckades, fortsätter utan talare", exc_info=True)
            num_speakers = 1
            diarization_failed = True
            warnings.append("Talarseparering ej tillgänglig")
        return time.perf_counter() - t

    def _run_transcription():
        nonlocal trans_result
        t = time.perf_counter()
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
            batch_size=config.batch_size,
        )
        return time.perf_counter() - t

    if skip_diarization:
        breakdown["diarization"] = _run_diarization()
        _progress("diarization", 0.35)
        breakdown["transcription"] = _run_transcription()
    else:
        with ThreadPoolExecutor(max_workers=2) as pool:
            diar_future = pool.submit(_run_diarization)
            trans_future = pool.submit(_run_transcription)

            # Diarization typically finishes first — report progress as it completes
            breakdown["diarization"] = diar_future.result()
            _progress("diarization", 0.35)

            breakdown["transcription"] = trans_future.result()

    _progress("transcription", 0.90)

    # 4. Matcha talare
    segments = _assign_speakers(trans_result.segments, diarization_segments)

    if skip_diarization or diarization_failed:
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
        "version": "0.2.0",
        "audio_source": config.audio_source,
    }

    output_files: list[Path] = []
    stem = audio_path.stem
    md_content: str | None = None

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

    if "docx" in config.output_formats:
        try:
            docx_path = config.output_dir / f"{stem}.docx"
            to_docx(segments, metadata, str(docx_path))
            output_files.append(docx_path)
            logger.info("Sparade Word: %s", docx_path)
        except ImportError:
            logger.error("python-docx är inte installerat — hoppar över .docx-export")

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
        md_content=md_content,
        warnings=warnings,
    )
