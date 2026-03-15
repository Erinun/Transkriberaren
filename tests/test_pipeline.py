"""Tester för pipeline-modulen."""

from pathlib import Path

import pytest

from motesskribent.diarization.diarizer import SpeakerSegment
from motesskribent.pipeline import PipelineConfig, PipelineResult, _assign_speakers
from motesskribent.transcription.transcriber import TranscribedSegment


class TestAssignSpeakers:
    """Enhetstester för _assign_speakers — kräver ingen modell."""

    def test_simple_overlap(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=0.0, end=2.0),
        ]
        d_segs = [
            SpeakerSegment(start=0.0, end=2.5, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _assign_speakers(t_segs, d_segs)
        assert result[0].speaker_id == "A"
        assert result[0].speaker_label == "Talare 1"

    def test_best_overlap_wins(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=1.0, end=5.0),
        ]
        d_segs = [
            SpeakerSegment(start=0.0, end=2.0, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=2.0, end=6.0, speaker_id="B", speaker_label="Talare 2"),
        ]
        result = _assign_speakers(t_segs, d_segs)
        # Overlap med A: min(5,2)-max(1,0)=1.0, med B: min(5,6)-max(1,2)=3.0
        assert result[0].speaker_id == "B"
        assert result[0].speaker_label == "Talare 2"

    def test_no_overlap(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=10.0, end=12.0),
        ]
        d_segs = [
            SpeakerSegment(start=0.0, end=2.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _assign_speakers(t_segs, d_segs)
        assert result[0].speaker_label == "Okänd talare"
        assert result[0].speaker_id is None

    def test_empty_diarization(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=0.0, end=1.0),
        ]
        result = _assign_speakers(t_segs, [])
        assert result[0].speaker_label == "Okänd talare"

    def test_empty_transcription(self):
        d_segs = [
            SpeakerSegment(start=0.0, end=2.0, speaker_id="A", speaker_label="Talare 1"),
        ]
        result = _assign_speakers([], d_segs)
        assert result == []

    def test_multiple_segments(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=0.0, end=2.0),
            TranscribedSegment(text="Hallå", start=3.0, end=5.0),
        ]
        d_segs = [
            SpeakerSegment(start=0.0, end=2.5, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=2.5, end=5.5, speaker_id="B", speaker_label="Talare 2"),
        ]
        result = _assign_speakers(t_segs, d_segs)
        assert result[0].speaker_id == "A"
        assert result[1].speaker_id == "B"

    def test_partial_overlap(self):
        t_segs = [
            TranscribedSegment(text="Hej", start=1.0, end=3.0),
        ]
        d_segs = [
            SpeakerSegment(start=0.0, end=1.5, speaker_id="A", speaker_label="Talare 1"),
            SpeakerSegment(start=2.5, end=4.0, speaker_id="B", speaker_label="Talare 2"),
        ]
        result = _assign_speakers(t_segs, d_segs)
        # Overlap med A: min(3,1.5)-max(1,0)=0.5, med B: min(3,4)-max(1,2.5)=0.5
        # Lika → första (A) vinner (> not >=)
        assert result[0].speaker_id == "A"


class TestPipelineConfig:
    """Enhetstester för PipelineConfig defaultvärden."""

    def test_defaults(self):
        cfg = PipelineConfig()
        assert cfg.model_path == "KBLab/kb-whisper-small"
        assert cfg.language == "sv"
        assert cfg.compute_type == "int8"
        assert cfg.beam_size == 5
        assert cfg.vad_enabled is True
        assert cfg.min_speakers == 2
        assert cfg.max_speakers == 10
        assert cfg.output_formats == ["markdown", "json"]

    def test_custom_values(self):
        cfg = PipelineConfig(
            model_path="custom/model",
            language="en",
            num_speakers=3,
            output_formats=["json"],
        )
        assert cfg.model_path == "custom/model"
        assert cfg.language == "en"
        assert cfg.num_speakers == 3
        assert cfg.output_formats == ["json"]


class TestPipelineResult:
    """Enhetstester för PipelineResult."""

    def test_construction(self):
        result = PipelineResult(
            output_files=[Path("out.md")],
            segments=[],
            num_speakers=2,
            total_duration=60.0,
            speech_duration=50.0,
            processing_time=30.0,
            processing_breakdown={"transcription": 20.0, "diarization": 10.0},
        )
        assert result.num_speakers == 2
        assert result.total_duration == 60.0
