"""Tester för kanalbaserad talarseparering med bleed-subtrahering."""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from motesskribent.diarization.channel_diarizer import (
    _estimate_bleed,
    _find_delay,
    _rms,
    _shift_signal,
    assign_speakers_by_channel,
)
from motesskribent.transcription.transcriber import TranscribedSegment


def _make_mono_wav(path: Path, signal: np.ndarray, sr: int = 16000):
    """Skapa en mono WAV-fil från en signal-array."""
    sf.write(str(path), signal.astype(np.float32), sr)


def _make_segment(start: float, end: float, text: str = "test") -> TranscribedSegment:
    return TranscribedSegment(text=text, start=start, end=end)


class TestFindDelay:
    """Tester för _find_delay (FFT-korskorrelation)."""

    def test_zero_delay(self):
        """Ingen fördröjning → delay=0."""
        rng = np.random.default_rng(42)
        system = rng.standard_normal(16000).astype(np.float32)
        mic = 0.5 * system  # Perfekt kopia, ingen fördröjning
        delay = _find_delay(mic, system, max_delay_ms=30.0, sample_rate=16000)
        assert delay == 0

    def test_known_delay(self):
        """Känd fördröjning (48 samples = 3ms) hittas korrekt."""
        rng = np.random.default_rng(42)
        system = rng.standard_normal(32000).astype(np.float32)
        known_delay = 48  # 3ms vid 16kHz
        # Mic = fördröjd kopia av system
        mic = np.zeros_like(system)
        mic[known_delay:] = 0.5 * system[: len(system) - known_delay]
        delay = _find_delay(mic, system, max_delay_ms=30.0, sample_rate=16000)
        assert abs(delay - known_delay) <= 1  # ±1 sample tolerans

    def test_delay_with_voice(self):
        """Fördröjning hittas även med okorrelerad röst i mic."""
        rng = np.random.default_rng(42)
        system = (0.5 * rng.standard_normal(32000)).astype(np.float32)
        known_delay = 32  # 2ms
        mic = np.zeros_like(system)
        mic[known_delay:] = 0.3 * system[: len(system) - known_delay]
        # Lägg till okorrelerad röst
        voice = (0.4 * rng.standard_normal(32000)).astype(np.float32)
        mic += voice
        delay = _find_delay(mic, system, max_delay_ms=30.0, sample_rate=16000)
        assert abs(delay - known_delay) <= 2  # Lite mer tolerans med brus

    def test_silent_system_returns_zero(self):
        """Tyst system → delay=0."""
        rng = np.random.default_rng(42)
        mic = rng.standard_normal(16000).astype(np.float32)
        system = np.zeros(16000, dtype=np.float32)
        delay = _find_delay(mic, system, max_delay_ms=30.0, sample_rate=16000)
        assert delay == 0

    def test_empty_signals(self):
        """Tomma signaler → delay=0."""
        delay = _find_delay(
            np.array([], dtype=np.float32),
            np.array([], dtype=np.float32),
        )
        assert delay == 0


class TestShiftSignal:
    """Tester för _shift_signal."""

    def test_zero_shift(self):
        sig = np.array([1.0, 2.0, 3.0], dtype=np.float32)
        result = _shift_signal(sig, 0)
        np.testing.assert_array_equal(result, sig)

    def test_positive_shift(self):
        sig = np.array([1.0, 2.0, 3.0, 4.0], dtype=np.float32)
        result = _shift_signal(sig, 2)
        expected = np.array([0.0, 0.0, 1.0, 2.0], dtype=np.float32)
        np.testing.assert_array_equal(result, expected)


class TestEstimateBleed:
    """Tester för _estimate_bleed hjälpfunktion."""

    def test_known_bleed_coefficient(self):
        """Känd bleed-koefficient återställs korrekt."""
        rng = np.random.default_rng(42)
        system = rng.standard_normal(16000).astype(np.float32)
        mic = 0.4 * system
        alpha = _estimate_bleed(mic, system)
        assert abs(alpha - 0.4) < 0.01

    def test_silent_system_returns_zero(self):
        """Tyst system ger alpha=0."""
        mic = np.ones(1000, dtype=np.float32) * 0.5
        system = np.zeros(1000, dtype=np.float32)
        assert _estimate_bleed(mic, system) == 0.0

    def test_negative_alpha_clipped_to_zero(self):
        """Negativt alpha klipps till 0 (ej fysikaliskt)."""
        system = np.array([1.0, -1.0, 1.0, -1.0], dtype=np.float32)
        mic = -0.5 * system  # Anti-korrelerad
        alpha = _estimate_bleed(mic, system)
        assert alpha == 0.0

    def test_no_bleed(self):
        """Okorrelerade signaler ger alpha nära 0."""
        rng = np.random.default_rng(42)
        system = rng.standard_normal(32000).astype(np.float32)
        mic = rng.standard_normal(32000).astype(np.float32)
        alpha = _estimate_bleed(mic, system)
        assert alpha < 0.1  # Nära 0 för okorrelerade signaler


class TestAssignSpeakersByChannel:
    """Tester för assign_speakers_by_channel."""

    def test_mic_only_speech(self, tmp_path):
        """Mic-kanal har signal, system tyst → alla segment = Talare 1."""
        sr = 16000
        duration = 3.0
        samples = int(sr * duration)
        t = np.linspace(0, duration, samples, endpoint=False, dtype=np.float32)

        mic_signal = 0.5 * np.sin(2 * np.pi * 440 * t)
        sys_signal = np.zeros(samples, dtype=np.float32)

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic_signal, sr)
        _make_mono_wav(sys_path, sys_signal, sr)

        segments = [
            _make_segment(0.0, 1.0, "Hej"),
            _make_segment(1.5, 2.5, "Världen"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 1
        for seg in result:
            assert seg.speaker_label == "Talare 1"
            assert seg.speaker_id == "SPEAKER_00"

    def test_system_only_speech(self, tmp_path):
        """System-kanal har signal, mic tyst → alla segment = Talare 2."""
        sr = 16000
        duration = 3.0
        samples = int(sr * duration)
        t = np.linspace(0, duration, samples, endpoint=False, dtype=np.float32)

        mic_signal = np.zeros(samples, dtype=np.float32)
        sys_signal = 0.5 * np.sin(2 * np.pi * 440 * t)

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic_signal, sr)
        _make_mono_wav(sys_path, sys_signal, sr)

        segments = [
            _make_segment(0.0, 1.0, "Hej"),
            _make_segment(1.5, 2.5, "Världen"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 1
        for seg in result:
            assert seg.speaker_label == "Talare 2"
            assert seg.speaker_id == "SPEAKER_01"

    def test_alternating_speakers(self, tmp_path):
        """Alternerande signal → korrekt uppdelning mic/system."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)
        t = np.linspace(0, duration, samples, endpoint=False, dtype=np.float32)

        mic_signal = np.zeros(samples, dtype=np.float32)
        sys_signal = np.zeros(samples, dtype=np.float32)

        # 0-1s: mic aktiv
        s0, e0 = 0, int(1.0 * sr)
        mic_signal[s0:e0] = 0.5 * np.sin(2 * np.pi * 440 * t[s0:e0])

        # 1-2s: system aktiv
        s1, e1 = int(1.0 * sr), int(2.0 * sr)
        sys_signal[s1:e1] = 0.5 * np.sin(2 * np.pi * 440 * t[s1:e1])

        # 2-3s: mic aktiv
        s2, e2 = int(2.0 * sr), int(3.0 * sr)
        mic_signal[s2:e2] = 0.5 * np.sin(2 * np.pi * 440 * t[s2:e2])

        # 3-4s: system aktiv
        s3, e3 = int(3.0 * sr), int(4.0 * sr)
        sys_signal[s3:e3] = 0.5 * np.sin(2 * np.pi * 440 * t[s3:e3])

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic_signal, sr)
        _make_mono_wav(sys_path, sys_signal, sr)

        segments = [
            _make_segment(0.0, 1.0, "Mic1"),
            _make_segment(1.0, 2.0, "Sys1"),
            _make_segment(2.0, 3.0, "Mic2"),
            _make_segment(3.0, 4.0, "Sys2"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"  # mic
        assert result[1].speaker_label == "Talare 2"  # system
        assert result[2].speaker_label == "Talare 1"  # mic
        assert result[3].speaker_label == "Talare 2"  # system

    def test_both_channels_active(self, tmp_path):
        """Båda aktiva → korrekt tilldelning via bleed-subtrahering."""
        sr = 16000
        duration = 2.0
        samples = int(sr * duration)
        t = np.linspace(0, duration, samples, endpoint=False, dtype=np.float32)

        mic_signal = np.zeros(samples, dtype=np.float32)
        sys_signal = np.zeros(samples, dtype=np.float32)

        s0, e0 = 0, int(1.0 * sr)
        mic_signal[s0:e0] = 0.8 * np.sin(2 * np.pi * 440 * t[s0:e0])
        sys_signal[s0:e0] = 0.1 * np.sin(2 * np.pi * 440 * t[s0:e0])

        s1, e1 = int(1.0 * sr), int(2.0 * sr)
        mic_signal[s1:e1] = 0.1 * np.sin(2 * np.pi * 440 * t[s1:e1])
        sys_signal[s1:e1] = 0.8 * np.sin(2 * np.pi * 440 * t[s1:e1])

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic_signal, sr)
        _make_mono_wav(sys_path, sys_signal, sr)

        segments = [
            _make_segment(0.0, 1.0, "Lokal"),
            _make_segment(1.0, 2.0, "Fjärr"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"

    def test_empty_segments(self, tmp_path):
        """Tom segmentlista returnerar tom lista och 1 talare."""
        sr = 16000
        signal = np.zeros(sr, dtype=np.float32)
        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, signal, sr)
        _make_mono_wav(sys_path, signal, sr)

        result, num_speakers = assign_speakers_by_channel([], mic_path, sys_path, sr)

        assert result == []
        assert num_speakers == 1

    # --- Bleed-subtrahering utan fördröjning ---

    def test_bleed_without_voice_all_system(self, tmp_path):
        """Mic har bara bleed från system (inget röst) → alla segment Talare 2."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)

        rng = np.random.default_rng(42)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)
        mic = (0.3 * system).astype(np.float32)

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Seg1"),
            _make_segment(2.0, 4.0, "Seg2"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 1
        for seg in result:
            assert seg.speaker_label == "Talare 2"
            assert seg.speaker_id == "SPEAKER_01"

    def test_voice_during_system_with_bleed(self, tmp_path):
        """Mic har bleed + röst i vissa segment → röst = Talare 1."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)

        rng = np.random.default_rng(42)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)
        mic = (0.3 * system).astype(np.float32)
        voice = (0.4 * rng.standard_normal(int(2.0 * sr))).astype(np.float32)
        mic[: int(2.0 * sr)] += voice

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Med röst"),
            _make_segment(2.0, 4.0, "Bara system"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"

    def test_high_bleed_still_detects_voice(self, tmp_path):
        """Hög bleed-koefficient (alpha=0.8) → röst detekteras ändå."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)

        rng = np.random.default_rng(123)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)
        mic = (0.8 * system).astype(np.float32)
        voice = (0.3 * rng.standard_normal(int(2.0 * sr))).astype(np.float32)
        mic[: int(2.0 * sr)] += voice

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Med röst"),
            _make_segment(2.0, 4.0, "Bara system"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"

    # --- Bleed med fördröjning (realistiskt scenario) ---

    def test_delayed_bleed_without_voice(self, tmp_path):
        """Mic har fördröjt bleed (3ms) utan röst → alla Talare 2."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)
        delay_samples = 48  # 3ms vid 16kHz

        rng = np.random.default_rng(42)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)

        # Mic = fördröjd kopia av system (simulerar högtalare → mikrofon)
        mic = np.zeros(samples, dtype=np.float32)
        mic[delay_samples:] = 0.3 * system[: samples - delay_samples]

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.5, 2.0, "Seg1"),
            _make_segment(2.0, 3.5, "Seg2"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 1
        for seg in result:
            assert seg.speaker_label == "Talare 2"

    def test_delayed_bleed_with_voice(self, tmp_path):
        """Mic har fördröjt bleed (3ms) + röst → korrekt separering."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)
        delay_samples = 48  # 3ms

        rng = np.random.default_rng(42)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)

        # Mic = fördröjt bleed + röst i 0-2s
        mic = np.zeros(samples, dtype=np.float32)
        mic[delay_samples:] = 0.3 * system[: samples - delay_samples]
        voice = (0.4 * rng.standard_normal(int(2.0 * sr))).astype(np.float32)
        mic[: int(2.0 * sr)] += voice

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Med röst"),
            _make_segment(2.0, 4.0, "Bara system"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"

    def test_large_delay_still_works(self, tmp_path):
        """Stor fördröjning (30ms, ~5m avstånd) hanteras."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)
        delay_samples = 480  # 30ms vid 16kHz

        rng = np.random.default_rng(99)
        system = (0.5 * rng.standard_normal(samples)).astype(np.float32)

        mic = np.zeros(samples, dtype=np.float32)
        mic[delay_samples:] = 0.4 * system[: samples - delay_samples]
        # Röst i 0-2s
        voice = (0.3 * rng.standard_normal(int(2.0 * sr))).astype(np.float32)
        mic[: int(2.0 * sr)] += voice

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Med röst"),
            _make_segment(2.0, 4.0, "Bara system"),
        ]

        result, num_speakers = assign_speakers_by_channel(
            segments, mic_path, sys_path, sr
        )

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"

    def test_system_silent_periods_are_mic_speaker(self, tmp_path):
        """Perioder där system är tyst → alltid Talare 1."""
        sr = 16000
        duration = 4.0
        samples = int(sr * duration)

        rng = np.random.default_rng(42)

        system = np.zeros(samples, dtype=np.float32)
        system[int(2.0 * sr) :] = (
            0.5 * rng.standard_normal(int(2.0 * sr))
        ).astype(np.float32)

        mic = (0.02 * rng.standard_normal(samples)).astype(np.float32)
        mic[int(2.0 * sr) :] += 0.3 * system[int(2.0 * sr) :]

        mic_path = tmp_path / "mic_16k.wav"
        sys_path = tmp_path / "system_16k.wav"
        _make_mono_wav(mic_path, mic, sr)
        _make_mono_wav(sys_path, system, sr)

        segments = [
            _make_segment(0.0, 2.0, "Tyst system"),
            _make_segment(2.0, 4.0, "Aktivt system"),
        ]

        result, _ = assign_speakers_by_channel(segments, mic_path, sys_path, sr)

        assert result[0].speaker_label == "Talare 1"
        assert result[1].speaker_label == "Talare 2"
