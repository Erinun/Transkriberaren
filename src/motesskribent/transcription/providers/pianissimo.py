"""Pianissimo (Klang, CC BY 4.0) via onnx-asr — lokal svensk standardmotor.

Modellen körs med onnxruntime på CPU, utan PyTorch. Ljudet delas upp vid
pauser med Silero VAD (onnx-asr:s egen ONNX-version), och token-tidsstämplarna
används för att bygga ord och dela långa talsegment i meningar så att
talartilldelningen blir lika finkornig som med KB-Whisper.
"""

from __future__ import annotations

import logging
import math
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from motesskribent.transcription.providers.base import (
    TranscriptionOptions,
    TranscriptionProgress,
    TranscriptionProvider,
)
from motesskribent.transcription.transcriber import (
    ModelResolutionError,
    TranscribedSegment,
    TranscribedWord,
    TranscriptionResult,
    clean_transcription_text,
)

logger = logging.getLogger(__name__)

REPO_ID = "KlangAI/pianissimo-sv-onnx"
QUANTIZATION = "int8"
MODEL_NAME = f"{REPO_ID} ({QUANTIZATION})"
LOCAL_DIR_NAME = "pianissimo-sv-onnx"
VAD_LOCAL_DIR_NAME = "silero-vad-onnx"
SAMPLE_RATE = 16000

# Uppdelning vid pauser. Samma tystnad/padding som KB-Whisper-flödet;
# max_speech_duration_s styr hur långa bitar modellen får (justeras efter mätning).
VAD_OPTIONS = dict(
    min_silence_duration_ms=500,
    speech_pad_ms=200,
    min_speech_duration_ms=250,
    max_speech_duration_s=30,
)

# Delning av långa talsegment i kortare transkriptsegment.
MAX_SEGMENT_S = 12.0      # dela senast efter så här lång tid
MIN_SENTENCE_S = 1.0      # dela vid meningsslut först efter minst så här lång tid
WORD_GAP_SPLIT_S = 0.8    # dela vid paus mellan ord längre än så här
WORD_TAIL_S = 0.4         # uppskattad längd efter sista token i ett ord
_SENTENCE_END = (".", "?", "!")
_WORD_START_MARKS = (" ", "▁", "Ġ")  # mellanslag, SentencePiece, BPE

_cached_adapter = None
_cached_key: tuple | None = None


def _candidate_model_roots() -> list[Path]:
    roots = []
    for env in ("MOTESSKRIBENT_MODELS_DIR", "HF_HOME"):
        value = os.environ.get(env)
        if value:
            roots.append(Path(value))
    # Utvecklingsläge: scripts/download_models.py lägger modellerna i <repo>/models
    parents = Path(__file__).resolve().parents
    if len(parents) > 4:
        roots.append(parents[4] / "models")
    return roots


def find_local_dir(name: str) -> Path | None:
    """Hitta en lokalt bundlad modellkatalog, eller None."""
    for root in _candidate_model_roots():
        candidate = root / name
        if candidate.is_dir() and any(candidate.iterdir()):
            return candidate
    return None


def _num_threads(cpu_threads: int | None) -> int:
    if cpu_threads:
        return cpu_threads
    return max(1, ((os.cpu_count() or 4) * 3) // 4)


def _get_adapter(cpu_threads: int | None = None):
    """Ladda (eller hämta cachad) Pianissimo + VAD som en tidsstämplad adapter."""
    global _cached_adapter, _cached_key

    threads = _num_threads(cpu_threads)
    key = (threads,)
    if _cached_adapter is not None and _cached_key == key:
        return _cached_adapter

    asr_dir = find_local_dir(LOCAL_DIR_NAME)
    vad_dir = find_local_dir(VAD_LOCAL_DIR_NAME)
    if os.environ.get("HF_HUB_OFFLINE") == "1" and (asr_dir is None or vad_dir is None):
        missing = LOCAL_DIR_NAME if asr_dir is None else VAD_LOCAL_DIR_NAME
        raise ModelResolutionError(
            f"Pianissimo-modellen hittades inte lokalt ({missing} saknas). "
            "Appen körs i offline-läge och kan inte ladda ner modeller."
        )

    import onnx_asr
    import onnxruntime as rt

    sess_options = rt.SessionOptions()
    sess_options.intra_op_num_threads = threads
    sess_options.inter_op_num_threads = 1

    logger.info("Laddar Pianissimo: dir=%s, vad=%s, trådar=%d", asr_dir or REPO_ID, vad_dir or "silero", threads)
    model = onnx_asr.load_model(REPO_ID, path=asr_dir, quantization=QUANTIZATION, sess_options=sess_options)
    vad = onnx_asr.load_vad("silero", path=vad_dir, sess_options=sess_options)
    adapter = model.with_vad(vad, **VAD_OPTIONS).with_timestamps()

    _cached_adapter = adapter
    _cached_key = key
    return adapter


def words_from_tokens(
    tokens: list[str] | None,
    timestamps: list[float] | None,
    logprobs: list[float] | None,
    seg_start: float,
    seg_end: float,
) -> list[TranscribedWord]:
    """Bygg ord med absoluta tider av delords-tokens.

    onnx-asr ger token-tider relativt talsegmentets början. En token som börjar
    med mellanslag (eller SentencePiece/BPE-markör) inleder ett nytt ord.
    """
    if not tokens or timestamps is None or len(tokens) != len(timestamps):
        return []

    groups: list[dict] = []
    for i, (token, ts) in enumerate(zip(tokens, timestamps)):
        lp = logprobs[i] if logprobs and i < len(logprobs) else 0.0
        t = seg_start + float(ts)
        if not groups or token.startswith(_WORD_START_MARKS):
            groups.append({"text": token.lstrip("".join(_WORD_START_MARKS)), "first": t, "last": t, "lps": [lp]})
        else:
            groups[-1]["text"] += token
            groups[-1]["last"] = t
            groups[-1]["lps"].append(lp)

    groups = [g for g in groups if g["text"].strip()]
    words: list[TranscribedWord] = []
    for i, g in enumerate(groups):
        next_start = groups[i + 1]["first"] if i + 1 < len(groups) else seg_end
        end = min(next_start, g["last"] + WORD_TAIL_S, seg_end)
        confidence = math.exp(sum(g["lps"]) / len(g["lps"])) if logprobs else 1.0
        words.append(TranscribedWord(
            word=g["text"].strip(),
            start=round(g["first"], 3),
            end=round(max(end, g["first"]), 3),
            confidence=min(max(confidence, 0.0), 1.0),
        ))
    return words


def split_into_segments(
    text: str,
    words: list[TranscribedWord],
    seg_start: float,
    seg_end: float,
) -> list[TranscribedSegment]:
    """Dela ett talsegment i kortare segment vid meningsslut och pauser."""
    if not words:
        cleaned = clean_transcription_text(text)
        return [TranscribedSegment(text=cleaned, start=seg_start, end=seg_end)] if cleaned else []

    groups: list[list[TranscribedWord]] = []
    current: list[TranscribedWord] = []
    for w in words:
        if current and (
            w.start - current[-1].end > WORD_GAP_SPLIT_S
            or w.end - current[0].start > MAX_SEGMENT_S
        ):
            groups.append(current)
            current = []
        current.append(w)
        if w.word.endswith(_SENTENCE_END) and current[-1].end - current[0].start >= MIN_SENTENCE_S:
            groups.append(current)
            current = []
    if current:
        groups.append(current)

    segments = []
    for g in groups:
        cleaned = clean_transcription_text(" ".join(w.word for w in g))
        if cleaned:
            segments.append(TranscribedSegment(text=cleaned, start=g[0].start, end=g[-1].end, words=g))
    return segments


class PianissimoProvider(TranscriptionProvider):
    id = "pianissimo"
    display_name = "Pianissimo"
    is_local = True

    def load(self, options: TranscriptionOptions) -> None:
        _get_adapter(options.cpu_threads)

    def transcribe(
        self,
        audio_path: Path | str,
        options: TranscriptionOptions,
        progress_callback: TranscriptionProgress | None = None,
    ) -> TranscriptionResult:
        audio_path = Path(audio_path)
        if not audio_path.exists():
            raise FileNotFoundError(f"Ljudfilen finns inte: {audio_path}")
        if options.language not in (None, "sv"):
            logger.warning("Pianissimo är tränad för svenska; språk '%s' ignoreras", options.language)
        if options.initial_prompt:
            logger.info("Pianissimo stöder inte initial_prompt; den ignoreras")

        adapter = _get_adapter(options.cpu_threads)

        data, sr = sf.read(str(audio_path), dtype="float32", always_2d=True)
        if sr != SAMPLE_RATE:
            raise ValueError(f"Pianissimo kräver {SAMPLE_RATE} Hz, fick {sr} Hz")
        waveform = np.ascontiguousarray(data.mean(axis=1), dtype=np.float32)
        duration = len(waveform) / SAMPLE_RATE

        logger.info("Startar Pianissimo-transkribering av: %s (%.1f s)", audio_path.name, duration)
        start_time = time.perf_counter()

        segments: list[TranscribedSegment] = []
        for res in adapter.recognize(waveform, sample_rate=SAMPLE_RATE):
            words = words_from_tokens(res.tokens, res.timestamps, res.logprobs, res.start, res.end)
            segments.extend(split_into_segments(res.text, words, res.start, res.end))
            if progress_callback is not None:
                progress_callback(len(segments), res.end, duration)

        elapsed = time.perf_counter() - start_time
        logger.info("Pianissimo klar: %d segment, %.1f s (ljud: %.1f s)", len(segments), elapsed, duration)

        return TranscriptionResult(
            segments=segments,
            language="sv",
            language_probability=1.0,
            processing_time=elapsed,
            model_name=MODEL_NAME,
            audio_duration=duration,
        )
