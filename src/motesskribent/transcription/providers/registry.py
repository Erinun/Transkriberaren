"""Register över tillgängliga transkriberingsleverantörer."""

from __future__ import annotations

from motesskribent.transcription.providers.base import TranscriptionProvider
from motesskribent.transcription.providers.kb_whisper import KbWhisperProvider

DEFAULT_PROVIDER = "kb-whisper"

_PROVIDERS: dict[str, type[TranscriptionProvider]] = {
    KbWhisperProvider.id: KbWhisperProvider,
}


def available_providers() -> list[str]:
    return list(_PROVIDERS)


def get_provider(provider_id: str | None = None) -> TranscriptionProvider:
    """Skapa leverantören med givet id (standard: KB-Whisper)."""
    provider_id = provider_id or DEFAULT_PROVIDER
    try:
        return _PROVIDERS[provider_id]()
    except KeyError:
        raise ValueError(
            f"Okänd transkriberingsmotor: '{provider_id}'. "
            f"Tillgängliga: {', '.join(_PROVIDERS)}"
        ) from None
