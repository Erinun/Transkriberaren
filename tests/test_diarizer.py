"""Tester för diarizer-modulen."""

from pathlib import Path

import pytest

from motesskribent.diarization.diarizer import (
    DiarizationResult,
    SpeakerSegment,
    _assign_labels,
    _merge_segments,
)

TEST_WAV = Path(__file__).parent / "fixtures" / "test_meeting.wav"


class TestMergeSegments:
    """Enhetstester för _merge_segments — kräver ingen modell."""

    def test_empty_list(self):
        assert _merge_segments([]) == []

    def test_single_segment(self):
        segs = [SpeakerSegment(start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1")]
        result = _merge_segments(segs)
        assert len(result) == 1
        assert result[0].start == 0.0
        assert result[0].end == 1.0

    def test_merge_same_speaker_small_gap(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=1.5, end=3.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=3.2, end=5.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _merge_segments(segs, max_gap=1.5)
        assert len(result) == 1
        assert result[0].start == 0.0
        assert result[0].end == 5.0

    def test_no_merge_different_speakers(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=1.2, end=3.0, speaker_id="B", speaker_label="Talare 2"),
        ]
        result = _merge_segments(segs, max_gap=1.5)
        assert len(result) == 2

    def test_no_merge_large_gap(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=5.0, end=6.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _merge_segments(segs, max_gap=1.5)
        assert len(result) == 2

    def test_mixed_merge_scenario(self):
        segs = [
            SpeakerSegment(start=0.0, end=2.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=2.5, end=4.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=4.5, end=6.0, speaker_id="B", speaker_label="Talare 2"),
            SpeakerSegment(start=6.2, end=8.0, speaker_id="B", speaker_label="Talare 2"),
            SpeakerSegment(start=10.0, end=12.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _merge_segments(segs, max_gap=1.5)
        assert len(result) == 3
        assert result[0].speaker_id == "A"
        assert result[0].end == 4.0
        assert result[1].speaker_id == "B"
        assert result[1].end == 8.0
        assert result[2].speaker_id == "A"
        assert result[2].start == 10.0

    def test_custom_max_gap(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=2.0, end=3.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        # Gap = 1.0, max_gap = 0.5 → ska INTE merga
        result = _merge_segments(segs, max_gap=0.5)
        assert len(result) == 2

        # Gap = 1.0, max_gap = 1.5 → ska merga
        result = _merge_segments(segs, max_gap=1.5)
        assert len(result) == 1


class TestAssignLabels:
    """Enhetstester för _assign_labels — kräver ingen modell."""

    def test_assigns_in_order_of_appearance(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="SPEAKER_02", speaker_label=""),
            SpeakerSegment(start=1.0, end=2.0, speaker_id="SPEAKER_00", speaker_label=""),
            SpeakerSegment(start=2.0, end=3.0, speaker_id="SPEAKER_02", speaker_label=""),
        ]
        _assign_labels(segs)
        assert segs[0].speaker_label == "Talare 1"
        assert segs[1].speaker_label == "Talare 2"
        assert segs[2].speaker_label == "Talare 1"

    def test_single_speaker(self):
        segs = [
            SpeakerSegment(start=0.0, end=1.0, speaker_id="SPEAKER_00", speaker_label=""),
            SpeakerSegment(start=1.0, end=2.0, speaker_id="SPEAKER_00", speaker_label=""),
        ]
        _assign_labels(segs)
        assert segs[0].speaker_label == "Talare 1"
        assert segs[1].speaker_label == "Talare 1"


@pytest.mark.skipif(
    not TEST_WAV.exists(),
    reason=f"Test-WAV saknas: {TEST_WAV}",
)
class TestDiarizeIntegration:
    """Integrationstester som kräver test-WAV + HF-token."""

    def test_diarize_produces_segments(self):
        from motesskribent.diarization.diarizer import diarize

        result = diarize(TEST_WAV)
        assert isinstance(result, DiarizationResult)
        assert len(result.segments) > 0
        assert result.num_speakers >= 1
