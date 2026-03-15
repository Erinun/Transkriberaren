"""Tester för transcriber-modulen."""

from pathlib import Path

import pytest

from motesskribent.transcription.transcriber import (
    TranscribedSegment,
    TranscribedWord,
    TranscriptionResult,
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
