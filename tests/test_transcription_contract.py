"""Låser hur pipelinen anropar KB-Whisper och vad den skriver ut.

Testerna körs utan modeller: transkriberingen ersätts med en fejk som
registrerar sina argument. De skrevs mot koden före leverantörslagret och
ska passera oförändrade efteråt — det visar att beteendet är detsamma.
Sedan steg 2 är Pianissimo standardmotor, så testerna väljer KB-Whisper
uttryckligen.
"""

from __future__ import annotations

import json

import numpy as np
import pytest
import soundfile as sf

from motesskribent.pipeline import PipelineConfig, run_pipeline
from motesskribent.transcription import transcriber
from motesskribent.transcription.transcriber import (
    TranscribedSegment,
    TranscribedWord,
    TranscriptionResult,
)

SR = 16000

# Exakt de argument (utöver ljudfil och progress_callback) som pipelinen
# skickade till transcriber.transcribe() före ombyggnaden, per profil.
EXPECTED_KWARGS = {
    "balanced": dict(
        model_path="KBLab/kb-whisper-base", language="sv", beam_size=1,
        cpu_threads=None, compute_type="int8", word_timestamps=False,
        initial_prompt=None, vad_filter=True, batch_size=16,
    ),
    "fast": dict(
        model_path="KBLab/kb-whisper-base", language="sv", beam_size=1,
        cpu_threads=None, compute_type="int8", word_timestamps=False,
        initial_prompt=None, vad_filter=True, batch_size=32,
    ),
    "quality": dict(
        model_path="KBLab/kb-whisper-base", language="sv", beam_size=5,
        cpu_threads=None, compute_type="int8", word_timestamps=False,
        initial_prompt=None, vad_filter=True, batch_size=8,
    ),
}


def _write_wav(path, channels: int, seconds: float = 2.0):
    t = np.linspace(0, seconds, int(SR * seconds), endpoint=False)
    tone = (0.1 * np.sin(2 * np.pi * 220 * t)).astype("float32")
    data = tone if channels == 1 else np.stack([tone, tone * 0.5], axis=1)
    sf.write(str(path), data, SR)
    return path


class FakeTranscribe:
    """Ersätter transcriber.transcribe och returnerar förbestämda segment."""

    def __init__(self, results_by_suffix: dict[str, list[TranscribedSegment]]):
        self.results_by_suffix = results_by_suffix
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, audio_path, progress_callback=None, **kwargs):
        name = str(audio_path)
        self.calls.append((name, kwargs))
        assert callable(progress_callback)
        progress_callback(1, 1.0, 2.0)
        segments = next(
            [TranscribedSegment(s.text, s.start, s.end, list(s.words)) for s in segs]
            for suffix, segs in self.results_by_suffix.items()
            if name.endswith(suffix)
        )
        return TranscriptionResult(
            segments=segments, language="sv", language_probability=1.0,
            processing_time=0.1, model_name=kwargs["model_path"], audio_duration=2.0,
        )


def _seg(text, start, end):
    return TranscribedSegment(
        text=text, start=start, end=end,
        words=[TranscribedWord(word=text, start=start, end=end, confidence=0.9)],
    )


@pytest.fixture
def no_diarizer(monkeypatch):
    import motesskribent.diarization.diarizer as diarizer

    def _fail(*a, **k):
        raise AssertionError("diarize() ska inte anropas i dessa flöden")

    monkeypatch.setattr(diarizer, "diarize", _fail)


@pytest.mark.parametrize("profile", ["balanced", "fast", "quality"])
def test_mono_single_speaker_call_and_output(tmp_path, monkeypatch, no_diarizer, profile):
    audio = _write_wav(tmp_path / "mote.wav", channels=1)
    fake = FakeTranscribe({"mote_16k.wav": [_seg("Hej allihop.", 0.0, 1.0), _seg("Välkomna.", 1.2, 1.9)]})
    monkeypatch.setattr(transcriber, "transcribe", fake)

    config = PipelineConfig(provider="kb-whisper", num_speakers=1, output_dir=tmp_path / "out", speed_profile=profile)
    result = run_pipeline(audio, config)

    assert len(fake.calls) == 1
    path, kwargs = fake.calls[0]
    assert path.endswith("mote_16k.wav")
    assert kwargs == EXPECTED_KWARGS[profile]

    assert [(s.text, s.start, s.end, s.speaker_label) for s in result.segments] == [
        ("Hej allihop. Välkomna.", 0.0, 1.9, "Talare 1"),
    ]
    data = json.loads((tmp_path / "out" / "mote.json").read_text(encoding="utf-8"))
    assert set(data["metadata"]) == {
        "date", "duration", "num_speakers", "processing_time", "model_name", "version", "audio_source",
    }
    assert data["metadata"]["model_name"] == "KBLab/kb-whisper-base"
    assert data["segments"] == [{
        "start": 0.0, "end": 1.9, "speaker_id": "SPEAKER_00",
        "speaker_label": "Talare 1", "text": "Hej allihop. Välkomna.",
    }]
    md = (tmp_path / "out" / "mote.md").read_text(encoding="utf-8")
    assert "**[00:00] Talare 1:**  \nHej allihop. Välkomna.\n" in md
    assert "*Modell: KBLab/kb-whisper-base*" in md


def test_stereo_transcribes_each_channel(tmp_path, monkeypatch, no_diarizer):
    audio = _write_wav(tmp_path / "rec.wav", channels=2)
    fake = FakeTranscribe({
        "rec_mic_16k.wav": [_seg("Jag börjar.", 0.0, 0.8)],
        "rec_system_16k.wav": [_seg("Okej, fortsätt.", 1.0, 1.8)],
    })
    monkeypatch.setattr(transcriber, "transcribe", fake)

    result = run_pipeline(audio, PipelineConfig(provider="kb-whisper", output_dir=tmp_path / "out", output_formats=["json"]))

    assert [p.rsplit("/", 1)[-1].rsplit("\\", 1)[-1] for p, _ in fake.calls] == [
        "rec_mic_16k.wav", "rec_system_16k.wav",
    ]
    assert all(k == EXPECTED_KWARGS["balanced"] for _, k in fake.calls)
    assert [(s.text, s.speaker_label) for s in result.segments] == [
        ("Jag börjar.", "Talare 1"), ("Okej, fortsätt.", "Talare 2"),
    ]
    assert result.num_speakers == 2


def test_stereo_falls_back_to_mono_when_channels_empty(tmp_path, monkeypatch, no_diarizer):
    audio = _write_wav(tmp_path / "rec.wav", channels=2)
    fake = FakeTranscribe({
        "rec_mic_16k.wav": [],
        "rec_system_16k.wav": [],
        "rec_16k.wav": [_seg("Bara mono.", 0.0, 1.0)],
    })
    monkeypatch.setattr(transcriber, "transcribe", fake)

    result = run_pipeline(audio, PipelineConfig(provider="kb-whisper", output_dir=tmp_path / "out", output_formats=["json"]))

    assert [p.rsplit("/", 1)[-1] for p, _ in fake.calls] == [
        "rec_mic_16k.wav", "rec_system_16k.wav", "rec_16k.wav",
    ]
    assert [s.text for s in result.segments] == ["Bara mono."]
