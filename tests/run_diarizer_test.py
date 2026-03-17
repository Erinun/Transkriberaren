"""
Standalone CLI-test för diarizer.

Användning:
    python tests/run_diarizer_test.py <ljud.wav>
    python tests/run_diarizer_test.py <ljud.wav> --num-speakers 3

Kräver:
    - diarize-biblioteket installerat (pip install diarize)
    - Ingen HF-token behövs — modeller laddas ned automatiskt
"""

import sys
import logging
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if len(sys.argv) < 2:
        print("Användning: python tests/run_diarizer_test.py <ljud.wav> [--num-speakers N]")
        sys.exit(1)

    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        print(f"Fel: Filen finns inte: {audio_path}")
        sys.exit(1)

    num_speakers = None
    if "--num-speakers" in sys.argv:
        idx = sys.argv.index("--num-speakers")
        if idx + 1 < len(sys.argv):
            num_speakers = int(sys.argv[idx + 1])

    from motesskribent.diarization.diarizer import diarize

    print(f"\nDiariserar: {audio_path}")
    if num_speakers:
        print(f"Antal talare (angivet): {num_speakers}")
    else:
        print("Antal talare: auto-detect")
    print("-" * 60)

    result = diarize(audio_path, num_speakers=num_speakers)

    print(f"\nAntal talare: {result.num_speakers}")
    print(f"Antal segment: {len(result.segments)}")
    print(f"Processtid: {result.processing_time:.1f} sek")
    print("=" * 60)

    for i, seg in enumerate(result.segments, 1):
        duration = seg.end - seg.start
        print(
            f"  [{seg.start:7.1f}s - {seg.end:7.1f}s] "
            f"({duration:5.1f}s) {seg.speaker_label} ({seg.speaker_id})"
        )

    # Sammanfattning per talare
    print("\n" + "-" * 60)
    print("Sammanfattning per talare:")
    speaker_times: dict[str, float] = {}
    for seg in result.segments:
        label = seg.speaker_label
        speaker_times[label] = speaker_times.get(label, 0.0) + (seg.end - seg.start)

    for label, total in sorted(speaker_times.items()):
        minutes = int(total // 60)
        seconds = total % 60
        print(f"  {label}: {minutes}m {seconds:.0f}s")

    print("\n" + "=" * 60)
    print("KLART!")


if __name__ == "__main__":
    main()
