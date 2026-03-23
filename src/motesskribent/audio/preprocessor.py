"""Ljudförbehandling: konvertering till 16kHz mono WAV + VAD-statistik."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio.functional

logger = logging.getLogger(__name__)


@dataclass
class PreprocessedAudio:
    """Resultat från ljudförbehandling."""
    audio_path: Path
    sample_rate: int
    duration_original: float
    duration_speech: float
    silence_removed_pct: float
    channel_audio_paths: list[Path] | None = None
    is_stereo_recording: bool = False


def preprocess_audio(
    input_path: Path | str,
    output_dir: Path | str,
    vad_threshold: float = 0.5,
    min_speech_duration: float = 0.5,
    min_silence_duration: float = 0.8,
    padding: float = 0.3,
    compute_vad_stats: bool = True,
) -> PreprocessedAudio:
    """Konvertera ljud till 16kHz mono WAV och beräkna VAD-statistik.

    Args:
        input_path: Sökväg till ljudfil (WAV, MP3, FLAC, OGG).
        output_dir: Katalog för konverterad WAV.
        vad_threshold: Tröskelvärde för VAD.
        min_speech_duration: Minsta tallängd i sekunder.
        min_silence_duration: Minsta tystnadslängd i sekunder.
        padding: Padding runt talsegment i sekunder.

    Returns:
        PreprocessedAudio med sökväg till konverterad fil och VAD-statistik.
    """
    input_path = Path(input_path)
    output_dir = Path(output_dir)

    if not input_path.exists():
        raise FileNotFoundError(f"Ljudfilen finns inte: {input_path}")

    output_dir.mkdir(parents=True, exist_ok=True)

    # 1. Ladda ljud med soundfile (kräver ej FFmpeg/torchcodec)
    data, sample_rate = sf.read(str(input_path), dtype="float32")
    # data: (samples,) för mono, (samples, channels) för stereo/multi
    if data.ndim == 1:
        waveform = torch.from_numpy(data).unsqueeze(0)  # (1, samples)
    else:
        waveform = torch.from_numpy(data.T)  # (channels, samples)
    duration_original = waveform.shape[1] / sample_rate

    # 2. Detektera stereo (mic+system) och spara separata kanalfiler
    target_sr = 16000
    is_stereo = waveform.shape[0] == 2
    channel_audio_paths: list[Path] | None = None

    if is_stereo:
        channel_audio_paths = []
        for ch_idx, ch_name in enumerate(["mic", "system"]):
            ch_waveform = waveform[ch_idx:ch_idx + 1]  # (1, samples)
            if sample_rate != target_sr:
                ch_waveform = torchaudio.functional.resample(ch_waveform, sample_rate, target_sr)
            ch_path = output_dir / f"{input_path.stem}_{ch_name}_16k.wav"
            sf.write(str(ch_path), ch_waveform.squeeze(0).numpy(), target_sr)
            channel_audio_paths.append(ch_path)
        logger.info("Stereo-inspelning: sparade separata kanalfiler (mic + system)")

    # 3. Konvertera till mono
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)

    # 4. Resampla till 16kHz
    if sample_rate != target_sr:
        waveform = torchaudio.functional.resample(waveform, sample_rate, target_sr)

    # 5. Spara mono som WAV
    output_path = output_dir / f"{input_path.stem}_16k.wav"
    audio_np = waveform.squeeze(0).numpy()
    sf.write(str(output_path), audio_np, target_sr)

    # 6. Kör VAD för statistik (kan hoppas över för snabbhet)
    if compute_vad_stats:
        duration_speech = 0.0
        try:
            from faster_whisper.vad import VadOptions, get_speech_timestamps

            vad_opts = VadOptions(
                threshold=vad_threshold,
                min_speech_duration_ms=int(min_speech_duration * 1000),
                min_silence_duration_ms=int(min_silence_duration * 1000),
                speech_pad_ms=int(padding * 1000),
            )

            audio_for_vad = waveform.squeeze(0).numpy()
            timestamps = get_speech_timestamps(audio_for_vad, vad_opts)

            for ts in timestamps:
                start_sec = ts["start"] / target_sr
                end_sec = ts["end"] / target_sr
                duration_speech += end_sec - start_sec

        except Exception:
            logger.warning("VAD misslyckades, hoppar över statistik", exc_info=True)
            duration_speech = duration_original
    else:
        duration_speech = duration_original

    silence_removed_pct = 0.0
    if duration_original > 0:
        silence_removed_pct = max(0.0, 1.0 - duration_speech / duration_original)

    logger.info(
        "Förbehandling klar: %.1fs ljud, %.1fs tal (%.0f%% tystnad)",
        duration_original, duration_speech, silence_removed_pct * 100,
    )

    return PreprocessedAudio(
        audio_path=output_path,
        sample_rate=target_sr,
        duration_original=duration_original,
        duration_speech=duration_speech,
        silence_removed_pct=silence_removed_pct,
        channel_audio_paths=channel_audio_paths,
        is_stereo_recording=is_stereo,
    )
