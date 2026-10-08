"""Gemensamt gränssnitt för transkriberingsleverantörer (tal → text)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from motesskribent.transcription.transcriber import TranscriptionResult

# (segment_index, segment_end_sekunder, ljudlängd_sekunder)
TranscriptionProgress = Callable[[int, float, float], None]


@dataclass
class TranscriptionOptions:
    """Inställningar som pipelinen skickar till leverantören.

    Alla fält är inte relevanta för alla leverantörer; en leverantör
    ignorerar det den inte stöder.
    """
    model: str = "KBLab/kb-whisper-base"
    language: str = "sv"
    beam_size: int = 1
    batch_size: int = 16
    cpu_threads: int | None = None
    compute_type: str = "int8"
    word_timestamps: bool = False
    initial_prompt: str | None = None
    vad_filter: bool = True


class TranscriptionProvider(ABC):
    """En motor som gör om en 16 kHz mono WAV-fil till tidsstämplade segment."""

    id: str
    display_name: str
    is_local: bool = True

    @abstractmethod
    def load(self, options: TranscriptionOptions) -> None:
        """Ladda modellen i minnet (används vid warmup)."""

    @abstractmethod
    def transcribe(
        self,
        audio_path: Path | str,
        options: TranscriptionOptions,
        progress_callback: TranscriptionProgress | None = None,
    ) -> TranscriptionResult:
        """Transkribera en ljudfil."""
