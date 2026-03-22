"""Tester för kanalbaserad talarseparering."""

from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from motesskribent.diarization.channel_diarizer import assign_speakers_by_channel
from motesskribent.transcription.transcriber import TranscribedSegment


def _make_mono_wav(path: Path, signal: np.ndarray, sr: int = 16000):
    """Skapa en mono WAV-fil från en signal-array."""
    sf.write(str(path), signal.astype(np.float32), sr)


def _make_segment(start: float, end: float, text: str = "test") -> TranscribedSegment:
    return TranscribedSegment(text=text, start=start, end=end)


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

        result, num_speakers = assign_speakers_by_channel(segments, mic_path, sys_path, sr)

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

        result, num_speakers = assign_speakers_by_channel(segments, mic_path, sys_path, sr)

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

        result, num_speakers = assign_speakers_by_channel(segments, mic_path, sys_path, sr)

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"  # mic
        assert result[1].speaker_label == "Talare 2"  # system
        assert result[2].speaker_label == "Talare 1"  # mic
        assert result[3].speaker_label == "Talare 2"  # system

    def test_both_channels_active_stronger_wins(self, tmp_path):
        """Båda aktiva men en starkare → starkare kanal vinner."""
        sr = 16000
        duration = 2.0
        samples = int(sr * duration)
        t = np.linspace(0, duration, samples, endpoint=False, dtype=np.float32)

        # Mic starkare i första sekunden
        mic_signal = np.zeros(samples, dtype=np.float32)
        sys_signal = np.zeros(samples, dtype=np.float32)

        s0, e0 = 0, int(1.0 * sr)
        mic_signal[s0:e0] = 0.8 * np.sin(2 * np.pi * 440 * t[s0:e0])
        sys_signal[s0:e0] = 0.1 * np.sin(2 * np.pi * 440 * t[s0:e0])

        # System starkare i andra sekunden
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

        result, num_speakers = assign_speakers_by_channel(segments, mic_path, sys_path, sr)

        assert num_speakers == 2
        assert result[0].speaker_label == "Talare 1"  # mic starkare
        assert result[1].speaker_label == "Talare 2"  # system starkare

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
