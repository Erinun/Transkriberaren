"""Register över tillgängliga transkriberingsleverantörer."""

from __future__ import annotations

from motesskribent.transcription.providers.base import TranscriptionProvider
from motesskribent.transcription.providers.kb_whisper import KbWhisperProvider
from motesskribent.transcription.providers.pianissimo import PianissimoProvider

DEFAULT_PROVIDER = "pianissimo"
# Används om vald lokal motor inte går att ladda eller köra.
FALLBACK_PROVIDER = "kb-whisper"

_PROVIDERS: dict[str, type[TranscriptionProvider]] = {
    PianissimoProvider.id: PianissimoProvider,
    KbWhisperProvider.id: KbWhisperProvider,
}


def available_providers() -> list[str]:
    return list(_PROVIDERS)


def get_provider(provider_id: str | None = None) -> TranscriptionProvider:
    """Skapa leverantören med givet id (standard: Pianissimo)."""
    provider_id = provider_id or DEFAULT_PROVIDER
    try:
        return _PROVIDERS[provider_id]()
    except KeyError:
        raise ValueError(
            f"Okänd transkriberingsmotor: '{provider_id}'. "
            f"Tillgängliga: {', '.join(_PROVIDERS)}"
        ) from None


def fallback_warning(failed: TranscriptionProvider, used: TranscriptionProvider, error: Exception) -> str:
    """Svenskt meddelande till användaren när reservmotorn fick ta över."""
    reason = str(error).strip().splitlines()[0] if str(error).strip() else type(error).__name__
    return f"{failed.display_name} kunde inte köras ({reason[:200]}). {used.display_name} användes i stället."
