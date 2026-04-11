"""
Talarseparering med diarize-biblioteket.

Använder diarize (FoxNoseTech, Apache 2.0) för att identifiera
vem som pratar när i en ljudfil. Baseras på Silero VAD +
WeSpeaker ONNX-embeddings + spektral klustring. Kräver ingen
HuggingFace-token.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# Module-level warmup flag
_models_warmed_up = False


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


def _warmup_models():
    """Säkerställ att diarize-modellerna (Silero VAD + WeSpeaker) är nedladdade."""
    global _models_warmed_up
    if _models_warmed_up:
        return
    from silero_vad import load_silero_vad
    import wespeakerruntime as wespeaker_rt
    load_silero_vad()
    wespeaker_rt.Speaker(lang="en")
    _models_warmed_up = True


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
    Mappa speaker-ID till läsbara etiketter (Talare 1, Talare 2, ...).

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
    min_speakers: int = 1,
    max_speakers: int = 10,
    merge_gap: float = 1.5,
) -> DiarizationResult:
    """
    Kör talarseparering på en ljudfil.

    Args:
        audio_path: Sökväg till ljudfil (WAV rekommenderas).
        num_speakers: Exakt antal talare (None = auto-detect).
        min_speakers: Minsta antal talare vid auto-detect.
        max_speakers: Maximalt antal talare vid auto-detect.
        merge_gap: Max gap i sekunder för att merga segment från samma talare.

    Returns:
        DiarizationResult med talarsegment och metadata.
    """
    from diarize import diarize as _lib_diarize

    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    logger.info("Startar diarisering av: %s", audio_path.name)
    start_time = time.perf_counter()

    # Bygg kwargs för diarize-anrop
    kwargs: dict = {"audio_path": str(audio_path)}
    if num_speakers is not None:
        kwargs["num_speakers"] = num_speakers
    else:
        kwargs["min_speakers"] = min_speakers
        kwargs["max_speakers"] = max_speakers

    result = _lib_diarize(**kwargs)

    # Logga diagnostikinfo om talaruppskattning
    if hasattr(result, "estimation_details") and result.estimation_details:
        details = result.estimation_details
        logger.info(
            "Talaruppskattning: metod=%s, best_k=%d, cosine_sim_p10=%s, reason=%s",
            details.method, details.best_k,
            f"{details.cosine_sim_p10:.3f}" if details.cosine_sim_p10 is not None else "N/A",
            details.reason or "auto",
        )
        if details.k_bics:
            logger.debug("BIC-värden per k: %s", details.k_bics)

    # Konvertera till SpeakerSegment-lista
    raw_segments: list[SpeakerSegment] = []
    for seg in result.segments:
        raw_segments.append(SpeakerSegment(
            start=seg.start,
            end=seg.end,
            speaker_id=seg.speaker,
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
