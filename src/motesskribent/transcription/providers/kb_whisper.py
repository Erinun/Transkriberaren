"""KB-Whisper via faster-whisper — appens ursprungliga motor."""

from __future__ import annotations

from pathlib import Path

from motesskribent.transcription import transcriber
from motesskribent.transcription.providers.base import (
    TranscriptionOptions,
    TranscriptionProgress,
    TranscriptionProvider,
)
from motesskribent.transcription.transcriber import TranscriptionResult


class KbWhisperProvider(TranscriptionProvider):
    id = "kb-whisper"
    display_name = "KB-Whisper"
    is_local = True

    def load(self, options: TranscriptionOptions) -> None:
        transcriber._get_model(options.model)

    def transcribe(
        self,
        audio_path: Path | str,
        options: TranscriptionOptions,
        progress_callback: TranscriptionProgress | None = None,
    ) -> TranscriptionResult:
        return transcriber.transcribe(
            audio_path,
            progress_callback=progress_callback,
            model_path=options.model,
            language=options.language,
            beam_size=options.beam_size,
            cpu_threads=options.cpu_threads,
            compute_type=options.compute_type,
            word_timestamps=options.word_timestamps,
            initial_prompt=options.initial_prompt,
            vad_filter=options.vad_filter,
            batch_size=options.batch_size,
        )
