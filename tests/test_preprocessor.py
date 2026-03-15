"""Tester för preprocessor-modulen."""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from motesskribent.audio.preprocessor import PreprocessedAudio, preprocess_audio


class TestPreprocessedAudioDataclass:
    """Enhetstester för PreprocessedAudio dataclass."""

    def test_construction(self):
        pa = PreprocessedAudio(
            audio_path=Path("/tmp/test.wav"),
            sample_rate=16000,
            duration_original=10.0,
            duration_speech=8.0,
            silence_removed_pct=0.2,
        )
        assert pa.sample_rate == 16000
        assert pa.duration_original == 10.0
        assert pa.silence_removed_pct == 0.2


def _make_wav(path: Path, sr: int = 16000, duration: float = 2.0, channels: int = 1):
    """Hjälpfunktion: generera syntetisk WAV med sinusvåg."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False, dtype=np.float32)
    signal = 0.5 * np.sin(2 * np.pi * 440 * t)
    if channels > 1:
        signal = np.column_stack([signal] * channels)
    sf.write(str(path), signal, sr)


class TestPreprocessAudio:
    """Enhetstester för preprocess_audio — använder syntetiska WAV-filer."""

    def test_mono_16k_passthrough(self, tmp_path):
        wav = tmp_path / "mono16k.wav"
        _make_wav(wav, sr=16000, duration=1.0, channels=1)

        result = preprocess_audio(wav, tmp_path / "out")
        assert result.audio_path.exists()
        assert result.sample_rate == 16000
        assert abs(result.duration_original - 1.0) < 0.1

    def test_stereo_to_mono(self, tmp_path):
        wav = tmp_path / "stereo.wav"
        _make_wav(wav, sr=16000, duration=1.0, channels=2)

        result = preprocess_audio(wav, tmp_path / "out")
        # Konverterad fil ska vara mono
        import soundfile as sf
        data, sr = sf.read(str(result.audio_path))
        assert data.ndim == 1  # mono

    def test_resample_44100_to_16000(self, tmp_path):
        wav = tmp_path / "high_sr.wav"
        _make_wav(wav, sr=44100, duration=1.0, channels=1)

        result = preprocess_audio(wav, tmp_path / "out")
        assert result.sample_rate == 16000
        data, sr = sf.read(str(result.audio_path))
        assert sr == 16000

    def test_file_not_found(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            preprocess_audio(tmp_path / "nonexistent.wav", tmp_path / "out")

    def test_vad_statistics_with_silence(self, tmp_path):
        """Sinusvåg + tystnad ska ge silence_removed_pct > 0."""
        sr = 16000
        duration = 3.0
        t = np.linspace(0, duration, int(sr * duration), endpoint=False, dtype=np.float32)
        signal = np.zeros_like(t)
        # Första sekunden: sinusvåg (tal)
        speech_end = int(sr * 1.0)
        signal[:speech_end] = 0.5 * np.sin(2 * np.pi * 440 * t[:speech_end])
        # Resten: tystnad

        wav = tmp_path / "speech_and_silence.wav"
        sf.write(str(wav), signal, sr)

        result = preprocess_audio(wav, tmp_path / "out")
        assert result.silence_removed_pct > 0.0
        assert result.duration_speech < result.duration_original

    def test_output_dir_created(self, tmp_path):
        wav = tmp_path / "test.wav"
        _make_wav(wav, sr=16000, duration=0.5)

        out_dir = tmp_path / "new_dir" / "sub"
        result = preprocess_audio(wav, out_dir)
        assert out_dir.exists()
        assert result.audio_path.exists()
