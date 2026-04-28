"""Tester för diarizer-modulen."""

from pathlib import Path

import pytest

import numpy as np

from motesskribent.diarization.diarizer import (
    DiarizationResult,
    SpeakerSegment,
    _assign_labels,
    _merge_segments,
    _merge_similar_speakers,
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


class TestMergeSimilarSpeakers:
    """Enhetstester för _merge_similar_speakers — kräver ingen modell."""

    def test_single_label_unchanged(self):
        embeddings = np.random.randn(5, 256).astype(np.float32)
        labels = np.zeros(5, dtype=int)
        result = _merge_similar_speakers(embeddings, labels)
        assert len(np.unique(result)) == 1

    def test_six_labels_same_speaker_merged_to_one(self):
        """6 labels men alla embeddings från samma fördelning → ska bli 1 talare."""
        rng = np.random.RandomState(42)
        base = rng.randn(256).astype(np.float32)
        base = base / np.linalg.norm(base)
        # 6 "talare" med 5 embeddings var, alla nära base
        embeddings = []
        labels = []
        for speaker_id in range(6):
            for _ in range(5):
                noise = rng.randn(256).astype(np.float32) * 0.05
                embeddings.append(base + noise)
                labels.append(speaker_id)
        embeddings = np.array(embeddings)
        labels = np.array(labels)

        result = _merge_similar_speakers(embeddings, labels, similarity_threshold=0.55)
        assert len(np.unique(result)) == 1

    def test_two_distinct_speakers_kept_separate(self):
        """2 talare med tydligt olika embeddings → ska förbli 2."""
        rng = np.random.RandomState(42)
        speaker_a = rng.randn(256).astype(np.float32)
        speaker_a = speaker_a / np.linalg.norm(speaker_a)
        speaker_b = -speaker_a  # maximalt annorlunda

        embeddings = []
        labels = []
        for _ in range(10):
            noise = rng.randn(256).astype(np.float32) * 0.05
            embeddings.append(speaker_a + noise)
            labels.append(0)
        for _ in range(10):
            noise = rng.randn(256).astype(np.float32) * 0.05
            embeddings.append(speaker_b + noise)
            labels.append(1)
        embeddings = np.array(embeddings)
        labels = np.array(labels)

        result = _merge_similar_speakers(embeddings, labels, similarity_threshold=0.55)
        assert len(np.unique(result)) == 2

    def test_three_labels_two_similar_one_different(self):
        """3 labels: 0 och 1 lika, 2 annorlunda → ska bli 2 talare."""
        rng = np.random.RandomState(42)
        speaker_a = rng.randn(256).astype(np.float32)
        speaker_a = speaker_a / np.linalg.norm(speaker_a)
        speaker_b = -speaker_a

        embeddings = []
        labels = []
        # Label 0 och 1: båda nära speaker_a
        for lbl in [0, 1]:
            for _ in range(5):
                noise = rng.randn(256).astype(np.float32) * 0.05
                embeddings.append(speaker_a + noise)
                labels.append(lbl)
        # Label 2: nära speaker_b
        for _ in range(5):
            noise = rng.randn(256).astype(np.float32) * 0.05
            embeddings.append(speaker_b + noise)
            labels.append(2)

        embeddings = np.array(embeddings)
        labels = np.array(labels)

        result = _merge_similar_speakers(embeddings, labels, similarity_threshold=0.55)
        assert len(np.unique(result)) == 2
        # Label 0 och 1 ska ha samma label efter merge
        assert result[0] == result[5]  # label 0 och label 1 sammanslagna
        # Label 2 ska vara annorlunda
        assert result[0] != result[10]

    def test_empty_embeddings(self):
        embeddings = np.array([]).reshape(0, 256)
        labels = np.array([], dtype=int)
        result = _merge_similar_speakers(embeddings, labels)
        assert len(result) == 0

    def test_labels_renumbered_from_zero(self):
        """After merge, labels should be renumbered 0, 1, 2, ..."""
        rng = np.random.RandomState(42)
        base = rng.randn(256).astype(np.float32)
        base = base / np.linalg.norm(base)

        embeddings = []
        labels = []
        # Speakers 0,1,2 all same → merge to 1
        for lbl in [0, 1, 2]:
            for _ in range(5):
                noise = rng.randn(256).astype(np.float32) * 0.05
                embeddings.append(base + noise)
                labels.append(lbl)

        embeddings = np.array(embeddings)
        labels = np.array(labels)

        result = _merge_similar_speakers(embeddings, labels, similarity_threshold=0.55)
        unique = np.unique(result)
        assert len(unique) == 1
        assert unique[0] == 0  # renumbered to 0


@pytest.mark.integration
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
