"""Kanalbaserad talarseparering för stereo-inspelningar (mic + systemljud).

Använder bleed-subtrahering med fördröjningskompensation för att separera
användarens röst från systemljudsläckage i mikrofon-kanalen.

Problemet: Systemljudet fångas digitalt (ren kopia) medan mikrofonen fångar
samma ljud via högtalarna med en tidsfördröjning (ljud reser ~3ms/meter).
Algoritmen uppskattar fördröjningen via korskorrelation, kompenserar för den,
och subtraherar sedan läckaget för att isolera användarens röst.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import soundfile as sf

from motesskribent.transcription.transcriber import TranscribedSegment

logger = logging.getLogger(__name__)

# Konstanter
_SILENCE_RMS = 0.005  # RMS under detta = tyst kanal
_NOISE_FACTOR = 3.0  # Rösttröskel = brusgolv × denna faktor
_MIN_VOICE_THRESHOLD = 0.005  # Absolut minsta rösttröskel
_FRAME_MS = 50  # Ram-storlek (ms) för brusgolv-beräkning
_MAX_DELAY_MS = 50.0  # Max fördröjning att söka (högtalare → mikrofon)


def assign_speakers_by_channel(
    segments: list[TranscribedSegment],
    mic_path: Path | str,
    system_path: Path | str,
    sample_rate: int = 16000,
) -> tuple[list[TranscribedSegment], int]:
    """Tilldela talare baserat på bleed-subtrahering med fördröjningskompensation.

    Algoritm:
        1. Hitta fördröjning via FFT-korskorrelation (högtalare → mikrofon)
        2. Skifta system-signalen och uppskatta läckagekoefficient alpha
        3. Skapa rensad mikrofonsignal: mic_clean = mic - alpha * system_aligned
        4. Per segment: om system tyst → Talare 1; annars kolla mic_clean
           mot adaptiv rösttröskel

    Args:
        segments: Transkriberade segment (utan talartilldelning).
        mic_path: Sökväg till mic-kanalens 16kHz mono WAV.
        system_path: Sökväg till system-kanalens 16kHz mono WAV.
        sample_rate: Samplingsfrekvens (standard 16000).

    Returns:
        (segments, num_speakers) — segmenten med speaker_id/speaker_label
        satta, och antal unika talare som hittades.
    """
    mic_audio, _ = sf.read(str(mic_path), dtype="float32")
    system_audio, _ = sf.read(str(system_path), dtype="float32")

    # Säkerställ samma längd
    min_len = min(len(mic_audio), len(system_audio))
    mic_audio = mic_audio[:min_len]
    system_audio = system_audio[:min_len]

    # Hitta fördröjning och uppskatta bleed med kompensation
    delay = _find_delay(mic_audio, system_audio, _MAX_DELAY_MS, sample_rate)
    system_aligned = _shift_signal(system_audio, delay)
    alpha = _estimate_bleed(mic_audio, system_aligned)

    # Skapa rensad mikrofonsignal
    mic_clean = mic_audio - alpha * system_aligned

    logger.info(
        "Bleed-analys: alpha=%.4f, delay=%d samples (%.1f ms)",
        alpha,
        delay,
        delay / sample_rate * 1000,
    )

    # Adaptiv rösttröskel baserad på brusgolv i rensade signalen
    voice_threshold = _compute_voice_threshold(mic_clean, sample_rate)

    logger.info("Rösttröskel=%.6f", voice_threshold)

    speakers_found: set[str] = set()
    speaker_counts = {"mic": 0, "system": 0}

    for seg in segments:
        start_sample = int(seg.start * sample_rate)
        end_sample = int(seg.end * sample_rate)

        sys_slice = system_audio[start_sample:end_sample]
        sys_rms = _rms(sys_slice)

        if sys_rms < _SILENCE_RMS:
            # System tyst → all mikrofonenergi = användaren
            seg.speaker_id = "SPEAKER_00"
            seg.speaker_label = "Talare 1"
            speaker_counts["mic"] += 1
        else:
            # System aktivt → kolla rensad mikrofon för röst
            clean_slice = mic_clean[start_sample:end_sample]
            clean_rms = _rms(clean_slice)

            if clean_rms > voice_threshold:
                seg.speaker_id = "SPEAKER_00"
                seg.speaker_label = "Talare 1"
                speaker_counts["mic"] += 1
                logger.debug(
                    "Segment %.1f-%.1fs: clean_rms=%.4f > tröskel=%.4f → Talare 1",
                    seg.start, seg.end, clean_rms, voice_threshold,
                )
            else:
                seg.speaker_id = "SPEAKER_01"
                seg.speaker_label = "Talare 2"
                speaker_counts["system"] += 1
                logger.debug(
                    "Segment %.1f-%.1fs: clean_rms=%.4f <= tröskel=%.4f → Talare 2",
                    seg.start, seg.end, clean_rms, voice_threshold,
                )

        speakers_found.add(seg.speaker_id)

    num_speakers = len(speakers_found) if speakers_found else 1

    logger.info(
        "Kanalbaserad talarseparering klar: %d segment, %d talare "
        "(mic=%d, system=%d)",
        len(segments),
        num_speakers,
        speaker_counts["mic"],
        speaker_counts["system"],
    )

    return segments, num_speakers


def _find_delay(
    mic: np.ndarray,
    system: np.ndarray,
    max_delay_ms: float = 50.0,
    sample_rate: int = 16000,
) -> int:
    """Hitta fördröjning mellan system och mic via FFT-korskorrelation.

    Systemljudet fångas digitalt (ingen fördröjning) medan mikrofonen
    fångar det via högtalare med en fysisk fördröjning. Denna funktion
    hittar den fördröjning som maximerar korrelationen.

    Returns:
        Fördröjning i antal samples (>= 0).
    """
    max_delay_samples = int(max_delay_ms * sample_rate / 1000)
    n = len(mic)

    if n == 0 or max_delay_samples <= 0:
        return 0

    # FFT-storlek: nästa 2-potens >= 2*n (undvik cirkulär aliasing)
    fft_size = 1
    while fft_size < 2 * n:
        fft_size <<= 1

    mic_fft = np.fft.rfft(mic, fft_size)
    sys_fft = np.fft.rfft(system, fft_size)

    # Korskorrelation: xcorr[k] = sum_t mic[t] * system[t-k]
    xcorr = np.fft.irfft(mic_fft * np.conj(sys_fft), fft_size)

    # Sök positiva lags (mic fördröjd relativt system)
    candidates = xcorr[: max_delay_samples + 1]

    if np.max(candidates) <= 0:
        return 0

    return int(np.argmax(candidates))


def _shift_signal(signal: np.ndarray, delay: int) -> np.ndarray:
    """Skifta signal framåt med delay samples (fyller med nollor i början)."""
    if delay <= 0:
        return signal
    shifted = np.zeros_like(signal)
    shifted[delay:] = signal[: len(signal) - delay]
    return shifted


def _estimate_bleed(mic: np.ndarray, system_aligned: np.ndarray) -> float:
    """Uppskatta läckagekoefficient med minsta-kvadrat-projektion.

    alpha = (mic · system_aligned) / (system_aligned · system_aligned)

    Förväntar att system_aligned redan är fördröjningskompenserad.
    Returnerar 0 om systemkanalen är tyst. Klipper till >= 0.
    """
    sys_energy = float(np.dot(system_aligned, system_aligned))
    if sys_energy < 1e-10:
        return 0.0
    alpha = float(np.dot(mic, system_aligned)) / sys_energy
    return max(alpha, 0.0)


def _compute_voice_threshold(
    mic_clean: np.ndarray,
    sample_rate: int,
) -> float:
    """Beräkna adaptiv rösttröskel från brusgolvet i rensade signalen.

    Delar signalen i korta ramar, beräknar RMS per ram, och använder
    25:e percentilen som brusgolv-uppskattning. Tröskeln sätts som
    brusgolv × faktor, med ett absolut minimum.
    """
    frame_size = int(sample_rate * _FRAME_MS / 1000)
    if len(mic_clean) < frame_size:
        return _MIN_VOICE_THRESHOLD

    num_frames = len(mic_clean) // frame_size
    frames = mic_clean[: num_frames * frame_size].reshape(num_frames, frame_size)
    frame_rms = np.sqrt(np.mean(frames**2, axis=1))

    noise_floor = float(np.percentile(frame_rms, 25))
    return max(noise_floor * _NOISE_FACTOR, _MIN_VOICE_THRESHOLD)


def _rms(samples: np.ndarray) -> float:
    """Beräkna RMS-energi för en array av samples."""
    if len(samples) == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples**2)))
