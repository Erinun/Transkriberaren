"""
Transkribering med faster-whisper och KB:s svenska Whisper-modell.

Använder faster-whisper med CTranslate2-backend för snabb CPU-inferens.
KB-Whisper-modeller (KBLab/kb-whisper-small etc.) har CTranslate2-format
direkt på HuggingFace — faster-whisper laddar dem automatiskt.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

from faster_whisper import WhisperModel

logger = logging.getLogger(__name__)

# Module-level model cache
_cached_model: WhisperModel | None = None
_cached_model_key: tuple | None = None


@dataclass
class TranscribedWord:
    """Ett enskilt transkriberat ord med tidsstämpel."""
    word: str
    start: float
    end: float
    confidence: float


@dataclass
class TranscribedSegment:
    """Ett transkriberat segment (typiskt en mening/fras)."""
    text: str
    start: float
    end: float
    words: list[TranscribedWord] = field(default_factory=list)
    speaker_id: str | None = None
    speaker_label: str | None = None


@dataclass
class TranscriptionResult:
    """Resultat från transkribering."""
    segments: list[TranscribedSegment]
    language: str
    language_probability: float
    processing_time: float
    model_name: str
    audio_duration: float


def _get_model(
    model_path: Path | str,
    compute_type: str = "int8",
    cpu_threads: int | None = None,
) -> WhisperModel:
    """
    Hämta eller skapa en cachad WhisperModel.

    Modellen cachas på modul-nivå med nyckel på (path, compute_type, threads)
    så att upprepade anrop inte laddar om modellen.
    """
    global _cached_model, _cached_model_key

    if cpu_threads is None:
        cpu_threads = max(1, (os.cpu_count() or 4) // 2)

    key = (str(model_path), compute_type, cpu_threads)

    if _cached_model is not None and _cached_model_key == key:
        logger.debug("Använder cachad modell: %s", key)
        return _cached_model

    logger.info(
        "Laddar modell: path=%s, compute_type=%s, cpu_threads=%d",
        model_path, compute_type, cpu_threads,
    )
    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    _cached_model = model
    _cached_model_key = key
    return model


def transcribe(
    audio_path: Path | str,
    model_path: Path | str = "KBLab/kb-whisper-small",
    language: str = "sv",
    beam_size: int = 5,
    cpu_threads: int | None = None,
    compute_type: str = "int8",
    word_timestamps: bool = True,
    initial_prompt: str | None = None,
    vad_filter: bool = True,
) -> TranscriptionResult:
    """
    Transkribera en ljudfil med faster-whisper och KB-Whisper.

    Args:
        audio_path: Sökväg till ljudfil (WAV, MP3, etc.)
        model_path: HuggingFace-ID eller lokal sökväg till CTranslate2-modell.
                     Default: "KBLab/kb-whisper-small" (auto-download).
        language: Språkkod (default "sv" för svenska).
        beam_size: Beam search-bredd (default 5).
        cpu_threads: Antal CPU-trådar (default: os.cpu_count() // 2).
        compute_type: Kvantiseringstyp (default "int8").
        word_timestamps: Returnera ord-tidsstämplar (default True).
        initial_prompt: Domänspecifika termer för bättre transkribering.
        vad_filter: Använd Silero VAD för att hoppa över tystnad (default True).

    Returns:
        TranscriptionResult med alla segment, språkinfo och metadata.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    model = _get_model(model_path, compute_type, cpu_threads)

    logger.info("Startar transkribering av: %s", audio_path.name)
    start_time = time.perf_counter()

    vad_parameters = dict(
        min_silence_duration_ms=500,
        speech_pad_ms=200,
    ) if vad_filter else None

    segments_gen, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        vad_filter=vad_filter,
        vad_parameters=vad_parameters,
        initial_prompt=initial_prompt,
    )

    # segments_gen är en generator — konsumera exakt en gång
    segments: list[TranscribedSegment] = []
    for seg in segments_gen:
        words = []
        if seg.words:
            for w in seg.words:
                words.append(TranscribedWord(
                    word=w.word,
                    start=w.start,
                    end=w.end,
                    confidence=w.probability,  # faster-whisper använder 'probability'
                ))

        segments.append(TranscribedSegment(
            text=seg.text.strip(),
            start=seg.start,
            end=seg.end,
            words=words,
        ))

    elapsed = time.perf_counter() - start_time

    logger.info(
        "Transkribering klar: %d segment, %.1f sek (ljud: %.1f sek)",
        len(segments), elapsed, info.duration,
    )

    return TranscriptionResult(
        segments=segments,
        language=info.language,
        language_probability=info.language_probability,
        processing_time=elapsed,
        model_name=str(model_path),
        audio_duration=info.duration,
    )
