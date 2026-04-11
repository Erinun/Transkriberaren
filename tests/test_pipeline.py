"""Tester för pipeline-modulen."""

from pathlib import Path

import pytest

from motesskribent.diarization.diarizer import SpeakerSegment
from motesskribent.pipeline import (
    SPEED_PROFILES,
    PipelineConfig,
    PipelineResult,
    _assign_speakers,
    _map_transcription_progress,
)
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
        assert cfg.model_path == "KBLab/kb-whisper-base"
        assert cfg.language == "sv"
        assert cfg.compute_type == "int8"
        assert cfg.beam_size == 1
        assert cfg.batch_size == 16
        assert cfg.speed_profile == "balanced"
        assert cfg.vad_enabled is True
        assert cfg.min_speakers == 1
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


class TestSpeedProfiles:
    """Tester för hastighetsprofiler."""

    def test_speed_profiles_defined(self):
        assert "fast" in SPEED_PROFILES
        assert "balanced" in SPEED_PROFILES
        assert "quality" in SPEED_PROFILES

    def test_fast_profile(self):
        cfg = PipelineConfig(speed_profile="fast")
        profile = SPEED_PROFILES["fast"]
        assert profile["beam_size"] == 1
        assert profile["batch_size"] == 32
        assert profile["word_timestamps"] is False

    def test_balanced_profile(self):
        cfg = PipelineConfig(speed_profile="balanced")
        profile = SPEED_PROFILES["balanced"]
        assert profile["beam_size"] == 1
        assert profile["batch_size"] == 16
        assert "word_timestamps" not in profile

    def test_quality_profile(self):
        cfg = PipelineConfig(speed_profile="quality")
        profile = SPEED_PROFILES["quality"]
        assert profile["beam_size"] == 5
        assert profile["batch_size"] == 8
        assert "word_timestamps" not in profile

    def test_all_profiles_have_required_keys(self):
        for name, profile in SPEED_PROFILES.items():
            assert "beam_size" in profile, f"Profile '{name}' missing beam_size"
            assert "batch_size" in profile, f"Profile '{name}' missing batch_size"

    def test_config_with_custom_profile(self):
        cfg = PipelineConfig(speed_profile="quality")
        assert cfg.speed_profile == "quality"

    def test_config_default_profile(self):
        cfg = PipelineConfig()
        assert cfg.speed_profile == "balanced"


class TestTranscriptionProgressMapping:
    """Enhetstester för _map_transcription_progress."""

    def test_phase_a_start(self):
        """Fas A, fraction=0 -> 5%."""
        result = _map_transcription_progress(0.0, diarization_done=False, fraction_at_diar_done=0.0)
        assert abs(result - 0.05) < 0.001

    def test_phase_a_midpoint(self):
        """Fas A, fraction=0.5 -> 15%."""
        result = _map_transcription_progress(0.5, diarization_done=False, fraction_at_diar_done=0.0)
        assert abs(result - 0.15) < 0.001

    def test_phase_a_end(self):
        """Fas A, fraction=1.0 -> 25%."""
        result = _map_transcription_progress(1.0, diarization_done=False, fraction_at_diar_done=0.0)
        assert abs(result - 0.25) < 0.001

    def test_phase_b_diar_done_at_half(self):
        """Fas B: diar klar vid fraction=0.5, nu på 0.75 -> halvvägs 30-90% = 60%."""
        result = _map_transcription_progress(0.75, diarization_done=True, fraction_at_diar_done=0.5)
        assert abs(result - 0.60) < 0.001

    def test_phase_b_diar_done_at_start(self):
        """Fas B: diar klar vid fraction=0.0, nu på 0.5 -> halvvägs 30-90% = 60%."""
        result = _map_transcription_progress(0.5, diarization_done=True, fraction_at_diar_done=0.0)
        assert abs(result - 0.60) < 0.001

    def test_phase_b_complete(self):
        """Fas B: fraction=1.0 -> 90%."""
        result = _map_transcription_progress(1.0, diarization_done=True, fraction_at_diar_done=0.5)
        assert abs(result - 0.90) < 0.001

    def test_phase_b_diar_done_at_end(self):
        """Edge case: diar done when transcription already at 1.0."""
        result = _map_transcription_progress(1.0, diarization_done=True, fraction_at_diar_done=1.0)
        assert abs(result - 0.90) < 0.001

    def test_phase_b_just_started(self):
        """Fas B: just after diar done, no additional progress -> 30%."""
        result = _map_transcription_progress(0.5, diarization_done=True, fraction_at_diar_done=0.5)
        assert abs(result - 0.30) < 0.001
