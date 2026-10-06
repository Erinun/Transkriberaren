"""Tester för Pianissimo-leverantören. onnx-asr och modellen ersätts med fejkar."""

from __future__ import annotations

import json
import sys
import types
from dataclasses import dataclass

import numpy as np
import pytest
import soundfile as sf

from motesskribent.pipeline import PipelineConfig, run_pipeline
from motesskribent.transcription import transcriber
from motesskribent.transcription.providers import TranscriptionOptions, get_provider
from motesskribent.transcription.providers import pianissimo
from motesskribent.transcription.providers.pianissimo import (
    PianissimoProvider,
    split_into_segments,
    words_from_tokens,
)
from motesskribent.transcription.transcriber import (
    ModelResolutionError,
    TranscribedSegment,
    TranscribedWord,
    TranscriptionResult,
)

SR = 16000


@dataclass
class FakeSegmentResult:
    """Samma fält som onnx_asr.vad.TimestampedSegmentResult."""
    start: float
    end: float
    text: str
    timestamps: list[float] | None
    tokens: list[str] | None
    logprobs: list[float] | None


class FakeAdapter:
    def __init__(self, results_per_call: list[list[FakeSegmentResult]]):
        self.results_per_call = list(results_per_call)
        self.calls = []

    def recognize(self, waveform, sample_rate=16000):
        self.calls.append((waveform.shape, waveform.dtype, sample_rate))
        return iter(self.results_per_call.pop(0))


def _wav(path, channels=1, seconds=3.0, sr=SR):
    n = int(sr * seconds)
    data = np.zeros(n, dtype="float32") if channels == 1 else np.zeros((n, channels), dtype="float32")
    sf.write(str(path), data, sr)
    return path


def _res(start, end, pieces):
    """pieces: [(token, relativ tid)]"""
    tokens = [t for t, _ in pieces]
    return FakeSegmentResult(
        start=start, end=end, text="".join(tokens).strip(),
        tokens=tokens, timestamps=[ts for _, ts in pieces], logprobs=[-0.1] * len(tokens),
    )


class TestWordsFromTokens:
    def test_groups_subwords_and_offsets_times(self):
        words = words_from_tokens(
            [" Hej", " all", "ihop", "."], [0.0, 0.4, 0.6, 0.9], [-0.1, -0.2, -0.2, -0.05],
            seg_start=10.0, seg_end=11.5,
        )
        assert [w.word for w in words] == ["Hej", "allihop."]
        assert words[0].start == 10.0
        assert words[0].end == 10.4          # nästa ords start
        assert words[1].start == 10.4
        assert words[1].end == pytest.approx(11.3)   # sista token + svans
        assert 0.8 < words[1].confidence < 0.9

    def test_sentencepiece_marker(self):
        words = words_from_tokens(["▁god", "▁morgon"], [0.0, 0.3], None, 0.0, 1.0)
        assert [w.word for w in words] == ["god", "morgon"]
        assert all(w.confidence == 1.0 for w in words)

    def test_first_token_without_space_starts_word(self):
        words = words_from_tokens(["ja", " visst"], [0.0, 0.2], None, 5.0, 6.0)
        assert [w.word for w in words] == ["ja", "visst"]

    def test_space_only_token_is_dropped(self):
        words = words_from_tokens([" ", "ok"], [0.0, 0.1], None, 0.0, 1.0)
        assert [w.word for w in words] == ["ok"]

    def test_missing_timestamps(self):
        assert words_from_tokens([" hej"], None, None, 0.0, 1.0) == []
        assert words_from_tokens(None, None, None, 0.0, 1.0) == []
        assert words_from_tokens([" a", " b"], [0.0], None, 0.0, 1.0) == []


def _w(word, start, end):
    return TranscribedWord(word=word, start=start, end=end, confidence=1.0)


class TestSplitIntoSegments:
    def test_splits_at_sentence_end(self):
        words = [_w("Vi", 0.0, 0.3), _w("börjar.", 0.3, 1.2), _w("Någon", 1.4, 1.8), _w("fråga?", 1.8, 2.5)]
        segs = split_into_segments("", words, 0.0, 2.6)
        assert [(s.text, s.start, s.end) for s in segs] == [
            ("Vi börjar.", 0.0, 1.2), ("Någon fråga?", 1.4, 2.5),
        ]
        assert segs[0].words == words[:2]

    def test_short_sentence_is_not_split(self):
        words = [_w("Ja.", 0.0, 0.3), _w("Precis.", 0.4, 0.9)]
        assert [s.text for s in split_into_segments("", words, 0.0, 1.0)] == ["Ja. Precis."]

    def test_splits_at_long_pause(self):
        words = [_w("först", 0.0, 0.5), _w("sedan", 2.0, 2.5)]
        assert [s.text for s in split_into_segments("", words, 0.0, 3.0)] == ["först", "sedan"]

    def test_splits_long_run_without_punctuation(self):
        words = [_w(f"ord{i}", i * 0.5, i * 0.5 + 0.4) for i in range(40)]  # 20 s utan punkt
        segs = split_into_segments("", words, 0.0, 20.0)
        assert len(segs) == 2
        assert all(s.end - s.start <= pianissimo.MAX_SEGMENT_S for s in segs)
        assert sum(len(s.words) for s in segs) == 40

    def test_without_words_keeps_vad_segment(self):
        segs = split_into_segments("  hej -- där  ", [], 4.0, 6.0)
        assert [(s.text, s.start, s.end) for s in segs] == [("hej där", 4.0, 6.0)]
        assert split_into_segments("   ", [], 0.0, 1.0) == []


class TestPianissimoProvider:
    def test_transcribe_builds_absolute_segments(self, tmp_path, monkeypatch):
        adapter = FakeAdapter([[
            _res(0.5, 2.0, [(" Hej", 0.0), (" alla.", 0.5)]),
            _res(2.5, 3.0, [(" Välkomna", 0.0)]),
        ]])
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: adapter)
        progress = []

        result = PianissimoProvider().transcribe(
            _wav(tmp_path / "a.wav"), TranscriptionOptions(), progress_callback=lambda *a: progress.append(a),
        )

        assert adapter.calls == [((48000,), np.dtype("float32"), 16000)]
        assert [(s.text, s.start, s.end) for s in result.segments] == [
            ("Hej alla.", 0.5, 1.4), ("Välkomna", 2.5, 2.9),
        ]
        assert result.model_name == "KlangAI/pianissimo-sv-onnx (int8)"
        assert result.language == "sv"
        assert result.audio_duration == 3.0
        assert progress == [(1, 2.0, 3.0), (2, 3.0, 3.0)]

    def test_rejects_wrong_sample_rate(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: FakeAdapter([[]]))
        with pytest.raises(ValueError, match="16000 Hz"):
            PianissimoProvider().transcribe(_wav(tmp_path / "a.wav", sr=44100), TranscriptionOptions())

    def test_missing_file(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            PianissimoProvider().transcribe(tmp_path / "nej.wav", TranscriptionOptions())

    def test_metadata(self):
        p = get_provider("pianissimo")
        assert (p.id, p.display_name, p.is_local) == ("pianissimo", "Pianissimo", True)


class TestModelLoading:
    @pytest.fixture(autouse=True)
    def _clear_cache(self, monkeypatch):
        monkeypatch.setattr(pianissimo, "_cached_adapter", None)
        monkeypatch.setattr(pianissimo, "_cached_key", None)

    def test_offline_without_bundled_model_raises(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HF_HUB_OFFLINE", "1")
        monkeypatch.setattr(pianissimo, "_candidate_model_roots", lambda: [tmp_path])
        with pytest.raises(ModelResolutionError, match="pianissimo-sv-onnx saknas"):
            pianissimo._get_adapter()

    def test_find_local_dir_uses_env(self, tmp_path, monkeypatch):
        (tmp_path / "pianissimo-sv-onnx").mkdir()
        (tmp_path / "pianissimo-sv-onnx" / "config.json").write_text("{}")
        (tmp_path / "tom").mkdir()
        monkeypatch.setenv("MOTESSKRIBENT_MODELS_DIR", str(tmp_path))
        assert pianissimo.find_local_dir("pianissimo-sv-onnx") == tmp_path / "pianissimo-sv-onnx"
        assert pianissimo.find_local_dir("tom") is None

    def test_loads_bundled_dirs_with_int8_and_vad_options(self, tmp_path, monkeypatch):
        for name in ("pianissimo-sv-onnx", "silero-vad-onnx"):
            (tmp_path / name).mkdir()
            (tmp_path / name / "x").write_text("x")
        monkeypatch.setenv("HF_HUB_OFFLINE", "1")
        monkeypatch.setattr(pianissimo, "_candidate_model_roots", lambda: [tmp_path])

        calls = {}

        class Model:
            def with_vad(self, vad, **kw):
                calls["vad"] = (vad, kw)
                return self

            def with_timestamps(self):
                calls["timestamps"] = True
                return "adapter"

        fake = types.SimpleNamespace(
            load_model=lambda repo, path=None, **kw: calls.setdefault("model", (repo, path, kw)) and Model(),
            load_vad=lambda name, path=None, **kw: calls.setdefault("vad_load", (name, path)) and "vad",
        )
        monkeypatch.setitem(sys.modules, "onnx_asr", fake)

        assert pianissimo._get_adapter(cpu_threads=3) == "adapter"
        repo, path, kw = calls["model"]
        assert (repo, path, kw["quantization"]) == ("KlangAI/pianissimo-sv-onnx", tmp_path / "pianissimo-sv-onnx", "int8")
        assert kw["sess_options"].intra_op_num_threads == 3
        assert calls["vad_load"] == ("silero", tmp_path / "silero-vad-onnx")
        assert calls["vad"] == ("vad", pianissimo.VAD_OPTIONS)
        assert calls["timestamps"] is True
        # Cachad: andra anropet laddar inte om
        calls.clear()
        assert pianissimo._get_adapter(cpu_threads=3) == "adapter"
        assert calls == {}


def _kb_result(segments):
    return TranscriptionResult(
        segments=segments, language="sv", language_probability=1.0,
        processing_time=0.0, model_name="KBLab/kb-whisper-base", audio_duration=3.0,
    )


@pytest.fixture
def no_diarizer(monkeypatch):
    import motesskribent.diarization.diarizer as diarizer
    monkeypatch.setattr(diarizer, "diarize", lambda *a, **k: pytest.fail("diarize anropades"))


class TestPipelineWithPianissimo:
    def test_default_engine_is_pianissimo(self, tmp_path, monkeypatch, no_diarizer):
        adapter = FakeAdapter([[_res(0.0, 1.5, [(" Hej", 0.0), (" där.", 0.4)])]])
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: adapter)
        monkeypatch.setattr(transcriber, "transcribe", lambda *a, **k: pytest.fail("KB-Whisper anropades"))

        result = run_pipeline(_wav(tmp_path / "m.wav"), PipelineConfig(num_speakers=1, output_dir=tmp_path / "out"))

        assert result.engine == "pianissimo"
        assert result.warnings == []
        assert [(s.text, s.speaker_label) for s in result.segments] == [("Hej där.", "Talare 1")]
        data = json.loads((tmp_path / "out" / "m.json").read_text(encoding="utf-8"))
        assert data["metadata"]["model_name"] == "KlangAI/pianissimo-sv-onnx (int8)"
        assert "*Modell: KlangAI/pianissimo-sv-onnx (int8)*" in (tmp_path / "out" / "m.md").read_text(encoding="utf-8")

    def test_falls_back_to_kb_whisper(self, tmp_path, monkeypatch, no_diarizer):
        def broken(*a, **k):
            raise RuntimeError("modellfilen är skadad")

        monkeypatch.setattr(pianissimo, "_get_adapter", broken)
        kb_calls = []

        def kb(audio_path, progress_callback=None, **kwargs):
            kb_calls.append(kwargs["model_path"])
            return _kb_result([TranscribedSegment(text="Från reserven.", start=0.0, end=1.0)])

        monkeypatch.setattr(transcriber, "transcribe", kb)

        result = run_pipeline(_wav(tmp_path / "m.wav"), PipelineConfig(
            num_speakers=1, output_dir=tmp_path / "out", output_formats=["json"],
        ))

        assert kb_calls == ["KBLab/kb-whisper-base"]
        assert result.engine == "kb-whisper"
        assert result.model_name == "KBLab/kb-whisper-base"
        assert result.warnings == [
            "Pianissimo kunde inte köras (modellfilen är skadad). KB-Whisper användes i stället."
        ]
        assert [s.text for s in result.segments] == ["Från reserven."]

    def test_stereo_fallback_reruns_both_channels_with_kb_whisper(self, tmp_path, monkeypatch, no_diarizer):
        adapter = FakeAdapter([[_res(0.0, 1.0, [(" mic", 0.0)])]])  # andra anropet kraschar (tom lista)
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: adapter)
        kb_files = []

        def kb(audio_path, progress_callback=None, **kwargs):
            kb_files.append(str(audio_path).rsplit("/", 1)[-1])
            text = "jag" if "mic" in str(audio_path) else "du"
            return _kb_result([TranscribedSegment(text=text, start=0.0 if text == "jag" else 1.5, end=1.0 if text == "jag" else 2.5)])

        monkeypatch.setattr(transcriber, "transcribe", kb)

        result = run_pipeline(_wav(tmp_path / "rec.wav", channels=2), PipelineConfig(
            output_dir=tmp_path / "out", output_formats=["json"],
        ))

        assert kb_files == ["rec_mic_16k.wav", "rec_system_16k.wav"]
        assert result.engine == "kb-whisper"
        assert [(s.text, s.speaker_label) for s in result.segments] == [("jag", "Talare 1"), ("du", "Talare 2")]

    def test_kb_whisper_failure_is_not_retried(self, tmp_path, monkeypatch, no_diarizer):
        monkeypatch.setattr(transcriber, "transcribe", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("trasig")))
        with pytest.raises(RuntimeError, match="trasig"):
            run_pipeline(_wav(tmp_path / "m.wav"), PipelineConfig(
                provider="kb-whisper", num_speakers=1, output_dir=tmp_path / "out",
            ))

    def test_sentence_split_gives_per_speaker_labels(self, tmp_path, monkeypatch):
        """Ett långt VAD-segment med två talare delas i meningar som får var sin talare."""
        from motesskribent.diarization import diarizer
        from motesskribent.diarization.diarizer import DiarizationResult, SpeakerSegment

        adapter = FakeAdapter([[_res(0.0, 6.0, [
            (" Jag", 0.0), (" föreslår", 0.4), (" att", 1.0), (" vi", 1.3), (" börjar.", 1.6),
            (" Det", 3.2), (" låter", 3.6), (" bra", 4.2), (" tycker", 4.6), (" jag.", 5.0),
        ])]])
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: adapter)
        monkeypatch.setattr(diarizer, "diarize", lambda *a, **k: DiarizationResult(
            segments=[
                SpeakerSegment(0.0, 3.0, "A", "Talare 1"),
                SpeakerSegment(3.0, 6.0, "B", "Talare 2"),
            ],
            num_speakers=2, processing_time=0.0,
        ))

        result = run_pipeline(_wav(tmp_path / "m.wav", seconds=6.0), PipelineConfig(
            num_speakers=2, output_dir=tmp_path / "out", output_formats=["json"],
        ))

        assert [(s.text, s.speaker_label) for s in result.segments] == [
            ("Jag föreslår att vi börjar.", "Talare 1"),
            ("Det låter bra tycker jag.", "Talare 2"),
        ]


class TestWarmup:
    def test_warmup_falls_back_when_pianissimo_cannot_load(self, monkeypatch, capsys):
        from motesskribent.server import _handle_warmup

        def broken(*a, **k):
            raise ModelResolutionError("Pianissimo-modellen hittades inte lokalt")

        monkeypatch.setattr(pianissimo, "_get_adapter", broken)
        loaded = []
        monkeypatch.setattr(transcriber, "_get_model", lambda m: loaded.append(m))

        _handle_warmup("w1", {"num_speakers": 1})

        events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
        done = events[-1]
        assert loaded == ["KBLab/kb-whisper-base"]
        assert done["percent"] == 100
        assert done["engine"] == "kb-whisper"
        assert "Pianissimo kunde inte köras" in done["engine_warning"]

    def test_warmup_loads_pianissimo_by_default(self, monkeypatch, capsys):
        from motesskribent.server import _handle_warmup

        loaded = []
        monkeypatch.setattr(pianissimo, "_get_adapter", lambda threads=None: loaded.append("p"))
        monkeypatch.setattr(transcriber, "_get_model", lambda m: pytest.fail("KB-Whisper laddades"))

        _handle_warmup("w2", {"num_speakers": 1})

        done = json.loads(capsys.readouterr().out.splitlines()[-1])
        assert loaded == ["p"]
        assert done["engine"] == "pianissimo"
        assert done["engine_warning"] is None
