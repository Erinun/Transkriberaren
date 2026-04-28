"""Tester för formatter-modulen."""

import json

from motesskribent.output.formatter import (
    clean_transcription_text,
    format_timestamp,
    merge_short_segments,
    to_json,
    to_markdown,
)
from motesskribent.transcription.transcriber import TranscribedSegment, TranscribedWord


class TestFormatTimestamp:
    """Enhetstester för format_timestamp."""

    def test_zero_seconds(self):
        assert format_timestamp(0.0) == "00:00"

    def test_under_one_minute(self):
        assert format_timestamp(45.0) == "00:45"

    def test_one_minute_five_seconds(self):
        assert format_timestamp(65.0) == "01:05"

    def test_over_one_hour(self):
        # 1 timme, 1 minut, 1 sekund = 3661 sekunder
        assert format_timestamp(3661.0) == "01:01:01"

    def test_negative_clamped_to_zero(self):
        assert format_timestamp(-5.0) == "00:00"

    def test_exact_one_hour(self):
        assert format_timestamp(3600.0) == "01:00:00"


class TestMergeShortSegments:
    """Enhetstester för merge_short_segments."""

    def test_empty_list(self):
        assert merge_short_segments([]) == []

    def test_single_segment(self):
        segs = [TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A")]
        result = merge_short_segments(segs)
        assert len(result) == 1
        assert result[0].text == "Hej"

    def test_merge_same_speaker(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
            TranscribedSegment(text="alla", start=1.5, end=2.5, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = merge_short_segments(segs, max_gap=2.0)
        assert len(result) == 1
        assert result[0].text == "Hej alla"
        assert result[0].start == 0.0
        assert result[0].end == 2.5

    def test_no_merge_different_speakers(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A"),
            TranscribedSegment(text="Hej", start=1.5, end=2.5, speaker_id="B"),
        ]
        result = merge_short_segments(segs, max_gap=2.0)
        assert len(result) == 2

    def test_no_merge_large_gap(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A"),
            TranscribedSegment(text="Hej", start=5.0, end=6.0, speaker_id="A"),
        ]
        result = merge_short_segments(segs, max_gap=2.0)
        assert len(result) == 2

    def test_none_speaker_merges_with_none(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id=None),
            TranscribedSegment(text="alla", start=1.5, end=2.5, speaker_id=None),
        ]
        result = merge_short_segments(segs, max_gap=2.0)
        assert len(result) == 1
        assert result[0].text == "Hej alla"

    def test_words_merged(self):
        w1 = TranscribedWord(word="Hej", start=0.0, end=0.5, confidence=0.9)
        w2 = TranscribedWord(word="alla", start=1.5, end=2.0, confidence=0.8)
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A", words=[w1]),
            TranscribedSegment(text="alla", start=1.5, end=2.5, speaker_id="A", words=[w2]),
        ]
        result = merge_short_segments(segs, max_gap=2.0)
        assert len(result) == 1
        assert len(result[0].words) == 2


class TestToMarkdown:
    """Enhetstester för to_markdown."""

    def test_contains_header(self):
        segs = [
            TranscribedSegment(text="Hej alla", start=0.0, end=2.0, speaker_label="Talare 1"),
        ]
        md = to_markdown(segs, {"date": "2025-01-15", "duration": 120.0, "num_speakers": 2,
                                 "processing_time": 10.0, "model_name": "test-model", "version": "0.1.0"})
        assert "# Mötesprotokoll" in md
        assert "2025-01-15" in md
        assert "Talare 1" in md

    def test_timestamps_in_output(self):
        segs = [
            TranscribedSegment(text="Test", start=65.0, end=70.0, speaker_label="Talare 1"),
        ]
        md = to_markdown(segs, {"date": "2025-01-15", "duration": 70.0, "num_speakers": 1,
                                 "processing_time": 5.0, "model_name": "m", "version": "0.1"})
        assert "[01:05]" in md

    def test_fallback_speaker_label(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="X", speaker_label=None),
        ]
        md = to_markdown(segs, {"date": "2025-01-15", "duration": 1.0, "num_speakers": 1,
                                 "processing_time": 1.0, "model_name": "m", "version": "v"})
        # Falls back to speaker_id when label is None
        assert "X" in md


class TestToJson:
    """Enhetstester för to_json."""

    def test_valid_json_output(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = to_json(segs, {"date": "2025-01-15"})
        parsed = json.loads(result)
        assert "metadata" in parsed
        assert "speakers" in parsed
        assert "segments" in parsed

    def test_segments_structure(self):
        segs = [
            TranscribedSegment(text="Hej", start=0.5, end=1.5, speaker_id="A", speaker_label="Talare 1"),
        ]
        parsed = json.loads(to_json(segs, {}))
        seg = parsed["segments"][0]
        assert seg["text"] == "Hej"
        assert seg["start"] == 0.5
        assert seg["end"] == 1.5
        assert seg["speaker_id"] == "A"

    def test_word_timestamps_included(self):
        w = TranscribedWord(word="Hej", start=0.0, end=0.5, confidence=0.95)
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A", words=[w]),
        ]
        parsed = json.loads(to_json(segs, {}, include_word_timestamps=True))
        assert "words" in parsed["segments"][0]
        assert parsed["segments"][0]["words"][0]["confidence"] == 0.95

    def test_word_timestamps_excluded_by_default(self):
        w = TranscribedWord(word="Hej", start=0.0, end=0.5, confidence=0.95)
        segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0, speaker_id="A", words=[w]),
        ]
        parsed = json.loads(to_json(segs, {}))
        assert "words" not in parsed["segments"][0]

    def test_ensure_ascii_false(self):
        segs = [
            TranscribedSegment(text="Ärende", start=0.0, end=1.0, speaker_id="A"),
        ]
        result = to_json(segs, {})
        # Swedish characters should appear directly, not as \u escapes
        assert "Ärende" in result


class TestCleanTranscriptionText:
    """Enhetstester för clean_transcription_text."""

    def test_removes_repeated_dashes(self):
        assert clean_transcription_text("Hej ---- världen") == "Hej världen"

    def test_removes_pipes(self):
        assert clean_transcription_text("Hej | världen ||") == "Hej världen"

    def test_removes_repeated_underscores(self):
        assert clean_transcription_text("Hej ___ världen") == "Hej världen"

    def test_removes_repeated_asterisks(self):
        assert clean_transcription_text("Hej *** världen") == "Hej världen"

    def test_removes_repeated_tildes(self):
        assert clean_transcription_text("Hej ~~~ världen") == "Hej världen"

    def test_collapses_multiple_spaces(self):
        assert clean_transcription_text("Hej    världen") == "Hej världen"

    def test_mixed_junk(self):
        assert clean_transcription_text("  |---Hej***  ~~världen__|  ") == "Hej världen"

    def test_normal_text_unchanged(self):
        assert clean_transcription_text("Det här är vanlig text.") == "Det här är vanlig text."

    def test_empty_string(self):
        assert clean_transcription_text("") == ""

    def test_single_dash_preserved(self):
        assert clean_transcription_text("ord-sammansättning") == "ord-sammansättning"

    def test_single_underscore_preserved(self):
        assert clean_transcription_text("ett_ord") == "ett_ord"
