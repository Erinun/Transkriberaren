"""Tester för steg 2b: fjärrdeltagare i stereo-inspelningar delas upp på flera talare."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf

from motesskribent.diarization import diarizer
from motesskribent.diarization.channel_diarizer import assign_system_speakers
from motesskribent.diarization.diarizer import DiarizationResult, SpeakerSegment
from motesskribent.pipeline import PipelineConfig, run_pipeline
from motesskribent.transcription import transcriber
from motesskribent.transcription.transcriber import TranscribedSegment, TranscriptionResult


def _seg(text, start, end, speaker_id=None, label=None):
    return TranscribedSegment(text=text, start=start, end=end, speaker_id=speaker_id, speaker_label=label)


def _mic(text, start, end):
    return _seg(text, start, end, "SPEAKER_00", "Talare 1")


def _sys(text, start, end):
    return _seg(text, start, end, "SPEAKER_01", "Talare 2")


def _d(start, end, speaker):
    return SpeakerSegment(start=start, end=end, speaker_id=speaker, speaker_label="")


class TestAssignSystemSpeakers:
    def test_remote_speakers_numbered_after_mic(self):
        segments = [
            _mic("Välkomna.", 0.0, 1.0),
            _sys("Tack, jag börjar.", 1.5, 3.0),
            _sys("Jag har en fråga.", 3.5, 5.0),
            _mic("Varsågod.", 5.2, 5.8),
            _sys("Jag fyller i.", 6.0, 7.0),
        ]
        diar = [_d(1.4, 3.1, "X"), _d(3.4, 5.1, "Y"), _d(5.9, 7.2, "X")]

        result = assign_system_speakers(segments, diar)

        assert [(s.text, s.speaker_id, s.speaker_label) for s in result] == [
            ("Välkomna.", "SPEAKER_00", "Talare 1"),
            ("Tack, jag börjar.", "SPEAKER_01", "Talare 2"),
            ("Jag har en fråga.", "SPEAKER_02", "Talare 3"),
            ("Varsågod.", "SPEAKER_00", "Talare 1"),
            ("Jag fyller i.", "SPEAKER_01", "Talare 2"),
        ]

    def test_largest_overlap_wins(self):
        segments = [_sys("a", 0.0, 4.0)]
        diar = [_d(0.0, 1.0, "X"), _d(1.0, 4.0, "Y")]
        assign_system_speakers(segments, diar)
        assert segments[0].speaker_label == "Talare 2"  # Y är första (enda) talaren som tilldelas

    def test_no_overlap_uses_nearest(self):
        segments = [_sys("a", 0.0, 1.0), _sys("b", 10.0, 11.0)]
        diar = [_d(1.2, 2.0, "X"), _d(9.0, 9.8, "Y")]
        assign_system_speakers(segments, diar)
        assert [s.speaker_label for s in segments] == ["Talare 2", "Talare 3"]

    def test_without_diarization_unchanged(self):
        segments = [_mic("a", 0.0, 1.0), _sys("b", 1.0, 2.0)]
        assert assign_system_speakers(segments, []) == segments
        assert [s.speaker_label for s in segments] == ["Talare 1", "Talare 2"]

    def test_mic_segments_never_change(self):
        segments = [_mic("a", 0.0, 2.0)]
        assign_system_speakers(segments, [_d(0.0, 2.0, "X")])
        assert (segments[0].speaker_id, segments[0].speaker_label) == ("SPEAKER_00", "Talare 1")


def _stereo_wav(path, seconds=8.0):
    sf.write(str(path), np.zeros((int(16000 * seconds), 2), dtype="float32"), 16000)
    return path


def _result(segments):
    return TranscriptionResult(
        segments=segments, language="sv", language_probability=1.0,
        processing_time=0.0, model_name="KBLab/kb-whisper-base", audio_duration=8.0,
    )


@pytest.fixture
def channel_transcripts(monkeypatch):
    """KB-Whisper-fejk: mic säger en sak, system innehåller två fjärrtalare."""
    def fake(audio_path, progress_callback=None, **kwargs):
        name = str(audio_path)
        if name.endswith("_mic_16k.wav"):
            return _result([_seg("Hej och välkomna.", 0.0, 1.5)])
        if name.endswith("_system_16k.wav"):
            return _result([
                _seg("Tack, Anna här.", 2.0, 3.5),
                _seg("Och Bertil här.", 4.0, 5.5),
                _seg("Anna igen.", 6.0, 7.0),
            ])
        raise AssertionError(f"oväntad fil {name}")

    monkeypatch.setattr(transcriber, "transcribe", fake)


class TestPipelineStereoDiarization:
    def test_auto_speakers_diarizes_system_channel(self, tmp_path, monkeypatch, channel_transcripts):
        calls = []

        def fake_diarize(audio_path, **kwargs):
            calls.append((str(audio_path), kwargs))
            return DiarizationResult(
                segments=[_d(1.9, 3.6, "A"), _d(3.9, 5.6, "B"), _d(5.9, 7.1, "A")],
                num_speakers=2, processing_time=0.0,
            )

        monkeypatch.setattr(diarizer, "diarize", fake_diarize)

        result = run_pipeline(_stereo_wav(tmp_path / "rec.wav"), PipelineConfig(
            provider="kb-whisper", output_dir=tmp_path / "out", output_formats=["json"],
        ))

        assert len(calls) == 1
        path, kwargs = calls[0]
        assert path.endswith("rec_system_16k.wav")
        assert kwargs == {"num_speakers": None, "min_speakers": 1, "max_speakers": 9}
        assert [(s.text, s.speaker_label) for s in result.segments] == [
            ("Hej och välkomna.", "Talare 1"),
            ("Tack, Anna här.", "Talare 2"),
            ("Och Bertil här.", "Talare 3"),
            ("Anna igen.", "Talare 2"),
        ]
        assert result.num_speakers == 3
        assert result.warnings == []

    def test_explicit_speaker_count_excludes_mic(self, tmp_path, monkeypatch, channel_transcripts):
        calls = []
        monkeypatch.setattr(diarizer, "diarize", lambda p, **k: calls.append(k) or DiarizationResult([], 0, 0.0))
        run_pipeline(_stereo_wav(tmp_path / "rec.wav"), PipelineConfig(
            provider="kb-whisper", num_speakers=4, output_dir=tmp_path / "out", output_formats=[],
        ))
        assert calls == [{"num_speakers": 3, "min_speakers": 1, "max_speakers": 9}]

    @pytest.mark.parametrize("n", [1, 2])
    def test_one_or_two_speakers_skips_diarization(self, tmp_path, monkeypatch, channel_transcripts, n):
        monkeypatch.setattr(diarizer, "diarize", lambda *a, **k: pytest.fail("diarize anropades"))
        result = run_pipeline(_stereo_wav(tmp_path / "rec.wav"), PipelineConfig(
            provider="kb-whisper", num_speakers=n, output_dir=tmp_path / "out", output_formats=[],
        ))
        assert {s.speaker_label for s in result.segments} == {"Talare 1", "Talare 2"}

    def test_diarization_failure_keeps_two_speakers_with_warning(self, tmp_path, monkeypatch, channel_transcripts):
        def broken(*a, **k):
            raise RuntimeError("WeSpeaker saknas")

        monkeypatch.setattr(diarizer, "diarize", broken)
        result = run_pipeline(_stereo_wav(tmp_path / "rec.wav"), PipelineConfig(
            provider="kb-whisper", output_dir=tmp_path / "out", output_formats=[],
        ))
        assert [s.speaker_label for s in result.segments] == ["Talare 1", "Talare 2"]
        assert result.num_speakers == 2
        assert result.warnings == ["Talarseparering av fjärrdeltagare ej tillgänglig – alla visas som Talare 2"]

    def test_silent_system_channel(self, tmp_path, monkeypatch):
        """Fysiskt möte utan fjärrdeltagare: tom systemkanal, tom diarisering."""
        def fake(audio_path, progress_callback=None, **kwargs):
            if str(audio_path).endswith("_mic_16k.wav"):
                return _result([_seg("Bara vi i rummet.", 0.0, 2.0)])
            return _result([])

        monkeypatch.setattr(transcriber, "transcribe", fake)
        monkeypatch.setattr(diarizer, "diarize", lambda *a, **k: DiarizationResult([], 0, 0.0))
        result = run_pipeline(_stereo_wav(tmp_path / "rec.wav"), PipelineConfig(
            provider="kb-whisper", output_dir=tmp_path / "out", output_formats=[],
        ))
        assert [(s.text, s.speaker_label) for s in result.segments] == [("Bara vi i rummet.", "Talare 1")]
        assert result.num_speakers == 1
