"""
Talarseparering med pyannote-audio.

Använder pyannote/speaker-diarization-3.1 för att identifiera
vem som pratar när i en ljudfil. pyannote 3.1 kör ren PyTorch
på CPU by default (ONNX Runtime-backend behövs inte).
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Module-level pipeline cache
_cached_pipeline = None
_cached_pipeline_key: str | None = None


@dataclass
class SpeakerSegment:
    """Ett tidssegment med identifierad talare."""
    start: float
    end: float
    speaker_id: str
    speaker_label: str


@dataclass
class DiarizationResult:
    """Resultat från talarseparering."""
    segments: list[SpeakerSegment]
    num_speakers: int
    processing_time: float


def _get_pipeline(
    hf_token: str | None = None,
    model_name: str = "pyannote/speaker-diarization-3.1",
):
    """
    Hämta eller skapa en cachad pyannote-pipeline.

    HF-token löses i ordning: parameter > HF_TOKEN env > huggingface-cli login.
    """
    global _cached_pipeline, _cached_pipeline_key

    if hf_token is None:
        hf_token = os.environ.get("HF_TOKEN")

    key = model_name

    if _cached_pipeline is not None and _cached_pipeline_key == key:
        logger.debug("Använder cachad pipeline: %s", key)
        return _cached_pipeline

    logger.info("Laddar diariseringspipeline: %s", model_name)

    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(
        model_name,
        token=hf_token,
    )

    _cached_pipeline = pipeline
    _cached_pipeline_key = key
    return pipeline


def _merge_segments(
    segments: list[SpeakerSegment],
    max_gap: float = 1.5,
) -> list[SpeakerSegment]:
    """
    Merga korta konsekutiva segment från samma talare.

    Om samma talare har flera segment med gap < max_gap sekunder
    emellan, slås de ihop till ett enda segment. Minskar fragmentering.
    """
    if not segments:
        return []

    merged: list[SpeakerSegment] = [SpeakerSegment(
        start=segments[0].start,
        end=segments[0].end,
        speaker_id=segments[0].speaker_id,
        speaker_label=segments[0].speaker_label,
    )]

    for seg in segments[1:]:
        prev = merged[-1]
        gap = seg.start - prev.end

        if seg.speaker_id == prev.speaker_id and gap < max_gap:
            # Förläng föregående segment
            prev.end = seg.end
        else:
            merged.append(SpeakerSegment(
                start=seg.start,
                end=seg.end,
                speaker_id=seg.speaker_id,
                speaker_label=seg.speaker_label,
            ))

    return merged


def _assign_labels(segments: list[SpeakerSegment]) -> list[SpeakerSegment]:
    """
    Mappa pyannote speaker-ID (SPEAKER_00) till läsbara etiketter (Talare 1).

    Etiketter tilldelas i ordning av första uppträdande i inspelningen.
    """
    label_map: dict[str, str] = {}
    counter = 0

    for seg in segments:
        if seg.speaker_id not in label_map:
            counter += 1
            label_map[seg.speaker_id] = f"Talare {counter}"
        seg.speaker_label = label_map[seg.speaker_id]

    return segments


def diarize(
    audio_path: Path | str,
    num_speakers: int | None = None,
    min_speakers: int = 2,
    max_speakers: int = 10,
    hf_token: str | None = None,
    merge_gap: float = 1.5,
) -> DiarizationResult:
    """
    Kör talarseparering på en ljudfil.

    Args:
        audio_path: Sökväg till ljudfil (WAV rekommenderas).
        num_speakers: Exakt antal talare (None = auto-detect).
        min_speakers: Minsta antal talare vid auto-detect.
        max_speakers: Maximalt antal talare vid auto-detect.
        hf_token: HuggingFace-token (annars HF_TOKEN env eller huggingface-cli login).
        merge_gap: Max gap i sekunder för att merga segment från samma talare.

    Returns:
        DiarizationResult med talarsegment och metadata.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    pipeline = _get_pipeline(hf_token=hf_token)

    logger.info("Startar diarisering av: %s", audio_path.name)
    start_time = time.perf_counter()

    # Bygg kwargs för pipeline-anrop
    kwargs = {}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers
    else:
        kwargs["min_speakers"] = min_speakers
        kwargs["max_speakers"] = max_speakers

    annotation = pipeline(str(audio_path), **kwargs)

    # Konvertera Annotation till SpeakerSegment-lista
    raw_segments: list[SpeakerSegment] = []
    for turn, _, speaker in annotation.itertracks(yield_label=True):
        raw_segments.append(SpeakerSegment(
            start=turn.start,
            end=turn.end,
            speaker_id=speaker,
            speaker_label="",  # Tilldelas nedan
        ))

    # Sortera efter starttid
    raw_segments.sort(key=lambda s: s.start)

    # Tilldela läsbara etiketter
    _assign_labels(raw_segments)

    # Merga korta konsekutiva segment från samma talare
    merged = _merge_segments(raw_segments, max_gap=merge_gap)

    elapsed = time.perf_counter() - start_time

    # Räkna unika talare
    unique_speakers = len({s.speaker_id for s in merged})

    logger.info(
        "Diarisering klar: %d segment, %d talare, %.1f sek",
        len(merged), unique_speakers, elapsed,
    )

    return DiarizationResult(
        segments=merged,
        num_speakers=unique_speakers,
        processing_time=elapsed,
    )
