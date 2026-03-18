"""Tester för transcriber-modulen."""

from pathlib import Path

import pytest

from motesskribent.transcription.transcriber import (
    TranscribedSegment,
    TranscribedWord,
    TranscriptionResult,
    _resolve_model_path,
)

# Sökväg till test-WAV (placera i tests/fixtures/)
TEST_WAV = Path(__file__).parent / "fixtures" / "test_meeting.wav"


class TestDataclasses:
    """Verifiera att dataklasserna fungerar korrekt."""

    def test_transcribed_word(self):
        w = TranscribedWord(word="hej", start=0.0, end=0.5, confidence=0.95)
        assert w.word == "hej"
        assert w.confidence == 0.95

    def test_transcribed_segment(self):
        seg = TranscribedSegment(
            text="Hej på dig",
            start=0.0,
            end=2.0,
            words=[],
        )
        assert seg.text == "Hej på dig"
        assert seg.speaker_id is None

    def test_transcribed_segment_with_speaker(self):
        seg = TranscribedSegment(
            text="Test",
            start=0.0,
            end=1.0,
            words=[],
            speaker_id="SPEAKER_00",
            speaker_label="Talare 1",
        )
        assert seg.speaker_label == "Talare 1"

    def test_transcription_result(self):
        result = TranscriptionResult(
            segments=[],
            language="sv",
            language_probability=0.98,
            processing_time=1.5,
            model_name="test-model",
            audio_duration=10.0,
        )
        assert result.language == "sv"
        assert result.audio_duration == 10.0


@pytest.mark.skipif(
    not TEST_WAV.exists(),
    reason=f"Test-WAV saknas: {TEST_WAV}",
)
class TestTranscribeIntegration:
    """Integrationstester som kräver en test-WAV-fil och modellen."""

    def test_transcribe_produces_segments(self):
        from motesskribent.transcription.transcriber import transcribe

        result = transcribe(TEST_WAV)
        assert isinstance(result, TranscriptionResult)
        assert len(result.segments) > 0
        assert result.language == "sv"
        assert result.audio_duration > 0

    def test_transcribe_word_timestamps(self):
        from motesskribent.transcription.transcriber import transcribe

        result = transcribe(TEST_WAV, word_timestamps=True)
        has_words = any(len(seg.words) > 0 for seg in result.segments)
        assert has_words, "Inga ord-tidsstämplar hittades"


class TestResolveModelPath:
    """Tester för _resolve_model_path()."""

    def test_local_directory_returned_as_is(self, tmp_path):
        """Om model_path redan är en lokal katalog, returnera direkt."""
        result = _resolve_model_path(tmp_path)
        assert result == tmp_path

    def test_model_id_without_hf_cache_returned_as_is(self, monkeypatch):
        """Utan HF_HUB_CACHE returneras modell-ID oförändrat."""
        monkeypatch.delenv("HF_HUB_CACHE", raising=False)
        result = _resolve_model_path("KBLab/kb-whisper-small")
        assert result == "KBLab/kb-whisper-small"

    def test_resolves_to_snapshot_dir_with_valid_cache(self, tmp_path, monkeypatch):
        """Med korrekt HF cache-struktur resolvas till snapshot-katalog."""
        # Bygg HF Hub cache-struktur
        cache_dir = tmp_path / "hf_cache"
        model_dir = cache_dir / "models--KBLab--kb-whisper-small"
        snapshot_hash = "abc123def456"
        snapshot_dir = model_dir / "snapshots" / snapshot_hash

        # Skapa refs/main med snapshot-hash
        refs_dir = model_dir / "refs"
        refs_dir.mkdir(parents=True)
        (refs_dir / "main").write_text(snapshot_hash, encoding="utf-8")

        # Skapa snapshot med model.bin
        snapshot_dir.mkdir(parents=True)
        (snapshot_dir / "model.bin").write_bytes(b"fake model data")

        monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
        result = _resolve_model_path("KBLab/kb-whisper-small")
        assert result == snapshot_dir

    def test_fallback_when_cache_dir_missing(self, tmp_path, monkeypatch):
        """Om cache-katalogen saknas, returnera modell-ID som fallback."""
        cache_dir = tmp_path / "empty_cache"
        cache_dir.mkdir()
        monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
        result = _resolve_model_path("KBLab/kb-whisper-small")
        assert result == "KBLab/kb-whisper-small"

    def test_fallback_when_refs_main_missing(self, tmp_path, monkeypatch):
        """Om refs/main saknas, returnera modell-ID som fallback."""
        cache_dir = tmp_path / "hf_cache"
        model_dir = cache_dir / "models--KBLab--kb-whisper-small"
        model_dir.mkdir(parents=True)
        monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
        result = _resolve_model_path("KBLab/kb-whisper-small")
        assert result == "KBLab/kb-whisper-small"

    def test_fallback_when_model_bin_missing(self, tmp_path, monkeypatch):
        """Om model.bin saknas i snapshot, returnera modell-ID som fallback."""
        cache_dir = tmp_path / "hf_cache"
        model_dir = cache_dir / "models--KBLab--kb-whisper-small"
        snapshot_hash = "abc123"
        snapshot_dir = model_dir / "snapshots" / snapshot_hash

        refs_dir = model_dir / "refs"
        refs_dir.mkdir(parents=True)
        (refs_dir / "main").write_text(snapshot_hash, encoding="utf-8")
        snapshot_dir.mkdir(parents=True)
        # Ingen model.bin skapad

        monkeypatch.setenv("HF_HUB_CACHE", str(cache_dir))
        result = _resolve_model_path("KBLab/kb-whisper-small")
        assert result == "KBLab/kb-whisper-small"
