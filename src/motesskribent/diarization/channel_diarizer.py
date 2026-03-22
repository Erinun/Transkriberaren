"""Kanalbaserad talarseparering för stereo-inspelningar (mic + systemljud)."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import soundfile as sf

from motesskribent.transcription.transcriber import TranscribedSegment

logger = logging.getLogger(__name__)


def assign_speakers_by_channel(
    segments: list[TranscribedSegment],
    mic_path: Path | str,
    system_path: Path | str,
    sample_rate: int = 16000,
) -> tuple[list[TranscribedSegment], int]:
    """Tilldela talare baserat på kanalenergi (RMS).

    Jämför RMS-energi i mic- vs system-kanalen för varje segment.
    Kanalen med högre energi avgör vilken talare segmentet tillhör.

    Args:
        segments: Transkriberade segment (utan talartilldelning).
        mic_path: Sökväg till mic-kanalens 16kHz mono WAV.
        system_path: Sökväg till system-kanalens 16kHz mono WAV.
        sample_rate: Samplingsfrekvens (standard 16000).

    Returns:
        (segments, num_speakers) — segmenten med speaker_id/speaker_label satta,
        och antal unika talare som hittades.
    """
    mic_audio, _ = sf.read(str(mic_path), dtype="float32")
    system_audio, _ = sf.read(str(system_path), dtype="float32")

    speakers_found: set[str] = set()

    for seg in segments:
        start_sample = int(seg.start * sample_rate)
        end_sample = int(seg.end * sample_rate)

        # Klipp ut segmentets tidsintervall från båda kanalerna
        mic_slice = mic_audio[start_sample:end_sample]
        sys_slice = system_audio[start_sample:end_sample]

        mic_rms = _rms(mic_slice)
        sys_rms = _rms(sys_slice)

        if mic_rms >= sys_rms:
            seg.speaker_id = "SPEAKER_00"
            seg.speaker_label = "Talare 1"
        else:
            seg.speaker_id = "SPEAKER_01"
            seg.speaker_label = "Talare 2"

        speakers_found.add(seg.speaker_id)

    num_speakers = len(speakers_found) if speakers_found else 1

    logger.info(
        "Kanalbaserad talarseparering klar: %d segment, %d talare",
        len(segments),
        num_speakers,
    )

    return segments, num_speakers


def _rms(samples: np.ndarray) -> float:
    """Beräkna RMS-energi för en array av samples."""
    if len(samples) == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples ** 2)))
