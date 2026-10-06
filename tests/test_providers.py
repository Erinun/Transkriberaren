"""Tester för leverantörslagret för transkribering. Kräver inga modeller."""

from __future__ import annotations

import numpy as np
import pytest
import soundfile as sf
from click.testing import CliRunner

from motesskribent.pipeline import PipelineConfig, run_pipeline
from motesskribent.transcription import transcriber
from motesskribent.transcription.providers import (
    DEFAULT_PROVIDER,
    FALLBACK_PROVIDER,
    TranscriptionOptions,
    TranscriptionProvider,
    available_providers,
    get_provider,
)
from motesskribent.transcription.providers import registry
from motesskribent.transcription.providers.kb_whisper import KbWhisperProvider
from motesskribent.transcription.providers.pianissimo import PianissimoProvider
from motesskribent.transcription.transcriber import TranscribedSegment, TranscriptionResult


def _result(segments, model="fake"):
    return TranscriptionResult(
        segments=segments, language="sv", language_probability=1.0,
        processing_time=0.0, model_name=model, audio_duration=1.0,
    )


class FakeProvider(TranscriptionProvider):
    id = "fake"
    display_name = "Fejk"

    def __init__(self):
        self.loaded_with = None
        self.calls = []

    def load(self, options):
        self.loaded_with = options

    def transcribe(self, audio_path, options, progress_callback=None):
        self.calls.append((str(audio_path), options))
        if progress_callback:
            progress_callback(1, 1.0, 1.0)
        return _result([TranscribedSegment(text="Från fejken.", start=0.0, end=0.9)])


@pytest.fixture
def fake_provider(monkeypatch):
    instance = FakeProvider()
    monkeypatch.setitem(registry._PROVIDERS, "fake", lambda: instance)
    return instance


class TestRegistry:
    def test_default_is_pianissimo(self):
        assert DEFAULT_PROVIDER == "pianissimo"
        assert isinstance(get_provider(), PianissimoProvider)
        assert isinstance(get_provider(None), PianissimoProvider)

    def test_fallback_is_kb_whisper(self):
        assert FALLBACK_PROVIDER == "kb-whisper"

    def test_both_engines_listed(self):
        assert available_providers() == ["pianissimo", "kb-whisper"]

    def test_unknown_provider_raises_swedish_error(self):
        with pytest.raises(ValueError, match="Okänd transkriberingsmotor: 'finns-inte'"):
            get_provider("finns-inte")

    def test_kb_whisper_is_local(self):
        provider = get_provider("kb-whisper")
        assert provider.is_local is True
        assert provider.display_name == "KB-Whisper"


class TestKbWhisperProvider:
    def test_transcribe_maps_options_to_transcriber(self, monkeypatch):
        captured = {}

        def fake_transcribe(audio_path, **kwargs):
            captured["audio_path"] = audio_path
            captured.update(kwargs)
            return _result([])

        monkeypatch.setattr(transcriber, "transcribe", fake_transcribe)
        cb = lambda *a: None  # noqa: E731
        options = TranscriptionOptions(
            model="KBLab/kb-whisper-small", beam_size=5, batch_size=8, cpu_threads=3,
            word_timestamps=True, initial_prompt="kommunfullmäktige", vad_filter=False,
        )
        KbWhisperProvider().transcribe("a.wav", options, progress_callback=cb)

        assert captured == dict(
            audio_path="a.wav", progress_callback=cb, model_path="KBLab/kb-whisper-small",
            language="sv", beam_size=5, cpu_threads=3, compute_type="int8",
            word_timestamps=True, initial_prompt="kommunfullmäktige", vad_filter=False,
            batch_size=8,
        )

    def test_load_uses_model_cache(self, monkeypatch):
        loaded = []
        monkeypatch.setattr(transcriber, "_get_model", lambda m: loaded.append(m))
        KbWhisperProvider().load(TranscriptionOptions(model="KBLab/kb-whisper-tiny"))
        assert loaded == ["KBLab/kb-whisper-tiny"]


class TestPipelineUsesProvider:
    def test_selected_provider_is_used(self, tmp_path, fake_provider, monkeypatch):
        monkeypatch.setattr(transcriber, "transcribe", lambda *a, **k: pytest.fail("KB-Whisper anropades"))
        audio = tmp_path / "m.wav"
        sf.write(str(audio), np.zeros(16000, dtype="float32"), 16000)

        result = run_pipeline(audio, PipelineConfig(
            provider="fake", num_speakers=1, output_dir=tmp_path / "out", output_formats=["json"],
        ))

        assert len(fake_provider.calls) == 1
        path, options = fake_provider.calls[0]
        assert path.endswith("m_16k.wav")
        assert options.model == "KBLab/kb-whisper-base"
        assert result.engine == "fake"
        assert [s.text for s in result.segments] == ["Från fejken."]

    def test_kb_whisper_engine_reported(self, tmp_path, monkeypatch):
        monkeypatch.setattr(transcriber, "transcribe", lambda *a, **k: _result([], model="KBLab/kb-whisper-base"))
        audio = tmp_path / "m.wav"
        sf.write(str(audio), np.zeros(16000, dtype="float32"), 16000)
        result = run_pipeline(audio, PipelineConfig(
            provider="kb-whisper", num_speakers=1, output_dir=tmp_path / "out", output_formats=[],
        ))
        assert result.engine == "kb-whisper"
        assert result.model_name == "KBLab/kb-whisper-base"
        assert result.warnings == []

    def test_unknown_provider_fails_before_work(self, tmp_path):
        audio = tmp_path / "m.wav"
        sf.write(str(audio), np.zeros(16000, dtype="float32"), 16000)
        with pytest.raises(ValueError, match="Okänd transkriberingsmotor"):
            run_pipeline(audio, PipelineConfig(provider="nej", output_dir=tmp_path / "out"))
        assert not (tmp_path / "out").exists()


class TestServerAndCli:
    def test_warmup_loads_selected_provider(self, fake_provider, capsys):
        from motesskribent.server import _handle_warmup

        _handle_warmup("r1", {"provider": "fake", "model": "m1", "num_speakers": 1})

        assert fake_provider.loaded_with.model == "m1"
        out = capsys.readouterr().out
        assert '"engine": "fake"' in out
        assert '"percent": 100' in out

    def test_transcribe_result_reports_engine(self, tmp_path, fake_provider, capsys):
        import json

        from motesskribent.server import _handle_transcribe

        audio = tmp_path / "m.wav"
        sf.write(str(audio), np.zeros(16000, dtype="float32"), 16000)
        _handle_transcribe("r2", str(audio), {
            "provider": "fake", "num_speakers": 1, "output_dir": str(tmp_path / "out"), "formats": ["json"],
        })
        events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        result = next(e for e in events if e.get("type") == "result")
        assert result["engine"] == "fake"
        assert result["engine_requested"] == "fake"
        assert result["model_name"] == "fake"
        assert result["segments"][0]["text"] == "Från fejken."

    def test_cli_motor_option(self, tmp_path, fake_provider):
        from motesskribent.cli import main

        audio = tmp_path / "m.wav"
        sf.write(str(audio), np.zeros(16000, dtype="float32"), 16000)
        res = CliRunner().invoke(main, [
            "transkribera", str(audio), "--motor", "fake", "--talare", "1",
            "--output", str(tmp_path / "out"), "--format", "json",
        ])
        assert res.exit_code == 0, res.output
        assert len(fake_provider.calls) == 1
