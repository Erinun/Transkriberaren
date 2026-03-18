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

from faster_whisper import BatchedInferencePipeline, WhisperModel

logger = logging.getLogger(__name__)

# Module-level model cache
_cached_model: WhisperModel | None = None
_cached_model_key: tuple | None = None
_cached_batched: BatchedInferencePipeline | None = None
_cached_batched_key: tuple | None = None


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


def _repair_broken_symlinks(directory: Path) -> int:
    """Replace broken symlinks in directory with copies from blobs/.

    Returns the number of repaired symlinks.
    """
    import shutil

    repaired = 0
    blobs_dir = directory.parent.parent / "blobs"
    if not blobs_dir.is_dir():
        return 0

    for p in directory.rglob("*"):
        if p.is_symlink() and not p.exists():
            # Broken symlink — try to find the target in blobs/
            target = os.readlink(p)
            target_name = Path(target).name
            blob_file = blobs_dir / target_name
            if blob_file.is_file():
                logger.info("Reparerar bruten symlink: %s -> %s", p, blob_file)
                p.unlink()
                shutil.copy2(blob_file, p)
                repaired += 1
            else:
                logger.warning("Kunde inte reparera bruten symlink: %s (blob %s saknas)", p, target_name)
    return repaired


def _resolve_model_path(model_path: Path | str) -> Path | str:
    """
    Resolva HF-modell-ID till lokal snapshot-katalog om HF_HUB_CACHE är satt.

    I bundlade miljöer (PyInstaller) sätts HF_HUB_CACHE till en lokal katalog
    med nerladdade modeller. WhisperModel klarar inte alltid HF Hub cache-lookup
    i dessa miljöer, så vi resolvar till den faktiska snapshot-katalogen direkt.

    Om model_path redan är en lokal katalog, eller om cache inte finns/är
    ofullständig, returneras model_path oförändrad.
    """
    path = Path(model_path)
    if path.is_dir():
        logger.debug("Modellsökväg är redan en lokal katalog: %s", path)
        return path

    hf_cache = os.environ.get("HF_HUB_CACHE")
    if not hf_cache:
        return model_path

    # Diagnostisk loggning för felsökning i bundlade miljöer
    logger.debug(
        "HF miljövariabler: HF_HUB_CACHE=%s, HF_HOME=%s, HF_HUB_OFFLINE=%s",
        hf_cache,
        os.environ.get("HF_HOME", "<ej satt>"),
        os.environ.get("HF_HUB_OFFLINE", "<ej satt>"),
    )

    # Konvertera HF modell-ID till cache-katalognamn: "KBLab/kb-whisper-small" → "models--KBLab--kb-whisper-small"
    model_id = str(model_path)
    cache_dir_name = "models--" + model_id.replace("/", "--")
    model_cache_dir = Path(hf_cache) / cache_dir_name

    if not model_cache_dir.is_dir():
        logger.debug("HF cache-katalog finns inte: %s", model_cache_dir)
        return model_path

    # Läs refs/main för att hitta snapshot-hash
    refs_main = model_cache_dir / "refs" / "main"
    if not refs_main.is_file():
        logger.debug("refs/main finns inte i: %s", model_cache_dir)
        return model_path

    try:
        snapshot_hash = refs_main.read_text(encoding="utf-8").strip()
    except OSError as e:
        logger.warning("Kunde inte läsa refs/main: %s", e)
        return model_path

    if not snapshot_hash:
        logger.debug("refs/main är tom i: %s", model_cache_dir)
        return model_path

    snapshot_dir = model_cache_dir / "snapshots" / snapshot_hash
    if not snapshot_dir.is_dir():
        logger.debug("Snapshot-katalog finns inte: %s", snapshot_dir)
        return model_path

    model_bin = snapshot_dir / "model.bin"

    # Detect broken symlinks (symlink exists but target is missing)
    if model_bin.is_symlink() and not model_bin.exists():
        logger.warning("model.bin är en bruten symlink i: %s", snapshot_dir)
        repaired = _repair_broken_symlinks(snapshot_dir)
        if repaired > 0:
            logger.info("Reparerade %d brutna symlinks i snapshot-katalogen", repaired)

    # Verifiera att model.bin finns (CTranslate2-modellens huvudfil)
    if not model_bin.is_file():
        logger.debug("model.bin saknas i snapshot: %s", snapshot_dir)
        return model_path

    logger.info("Resolvade HF modell-ID '%s' till lokal sökväg: %s", model_id, snapshot_dir)
    return snapshot_dir


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
        cpu_threads = max(1, ((os.cpu_count() or 4) * 3) // 4)

    key = (str(model_path), compute_type, cpu_threads)

    if _cached_model is not None and _cached_model_key == key:
        logger.debug("Använder cachad modell: %s", key)
        return _cached_model

    resolved = _resolve_model_path(model_path)

    logger.info(
        "Laddar modell: path=%s, compute_type=%s, cpu_threads=%d",
        resolved, compute_type, cpu_threads,
    )
    model = WhisperModel(
        str(resolved),
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    _cached_model = model
    _cached_model_key = key
    return model


def _get_batched_pipeline(
    model_path: Path | str,
    compute_type: str = "int8",
    cpu_threads: int | None = None,
) -> BatchedInferencePipeline:
    """Hämta eller skapa en cachad BatchedInferencePipeline."""
    global _cached_batched, _cached_batched_key

    if cpu_threads is None:
        cpu_threads = max(1, ((os.cpu_count() or 4) * 3) // 4)

    key = (str(model_path), compute_type, cpu_threads)

    if _cached_batched is not None and _cached_batched_key == key:
        logger.debug("Använder cachad batched pipeline: %s", key)
        return _cached_batched

    model = _get_model(model_path, compute_type, cpu_threads)
    pipeline = BatchedInferencePipeline(model=model)

    _cached_batched = pipeline
    _cached_batched_key = key
    return pipeline


def transcribe(
    audio_path: Path | str,
    model_path: Path | str = "KBLab/kb-whisper-small",
    language: str = "sv",
    beam_size: int = 1,
    cpu_threads: int | None = None,
    compute_type: str = "int8",
    word_timestamps: bool = True,
    initial_prompt: str | None = None,
    vad_filter: bool = True,
    batch_size: int = 16,
) -> TranscriptionResult:
    """
    Transkribera en ljudfil med faster-whisper och KB-Whisper.

    Args:
        audio_path: Sökväg till ljudfil (WAV, MP3, etc.)
        model_path: HuggingFace-ID eller lokal sökväg till CTranslate2-modell.
                     Default: "KBLab/kb-whisper-small" (auto-download).
        language: Språkkod (default "sv" för svenska).
        beam_size: Beam search-bredd (default 1, greedy decoding).
        cpu_threads: Antal CPU-trådar (default: os.cpu_count() * 3/4).
        compute_type: Kvantiseringstyp (default "int8").
        word_timestamps: Returnera ord-tidsstämplar (default True).
        initial_prompt: Domänspecifika termer för bättre transkribering.
        vad_filter: Använd Silero VAD för att hoppa över tystnad (default True).
        batch_size: Batch-storlek för BatchedInferencePipeline (default 16).
                    Sätts till 0 för att använda standard sekventiell inferens.

    Returns:
        TranscriptionResult med alla segment, språkinfo och metadata.
    """
    audio_path = Path(audio_path)
    if not audio_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")

    logger.info("Startar transkribering av: %s (batch_size=%d, beam_size=%d)", audio_path.name, batch_size, beam_size)
    start_time = time.perf_counter()

    vad_parameters = dict(
        min_silence_duration_ms=500,
        speech_pad_ms=200,
    ) if vad_filter else None

    if batch_size > 0:
        pipeline = _get_batched_pipeline(model_path, compute_type, cpu_threads)
        segments_gen, info = pipeline.transcribe(
            str(audio_path),
            language=language,
            beam_size=beam_size,
            word_timestamps=word_timestamps,
            batch_size=batch_size,
            initial_prompt=initial_prompt,
        )
    else:
        model = _get_model(model_path, compute_type, cpu_threads)
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
