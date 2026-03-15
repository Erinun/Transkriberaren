"""
Standalone CLI-test för transcriber.

Användning:
    python tests/run_transcriber_test.py <ljud.wav>
    python tests/run_transcriber_test.py <ljud.wav> --model KBLab/kb-whisper-medium
"""

import sys
import logging
from pathlib import Path

# Lägg till src/ i sökvägen så att vi kan importera utan installation
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if len(sys.argv) < 2:
        print("Användning: python tests/run_transcriber_test.py <ljud.wav> [--model MODEL]")
        sys.exit(1)

    audio_path = Path(sys.argv[1])
    if not audio_path.exists():
        print(f"Fel: Filen finns inte: {audio_path}")
        sys.exit(1)

    model_path = "KBLab/kb-whisper-small"
    if "--model" in sys.argv:
        idx = sys.argv.index("--model")
        if idx + 1 < len(sys.argv):
            model_path = sys.argv[idx + 1]

    from motesskribent.transcription.transcriber import transcribe

    print(f"\nTranskriberar: {audio_path}")
    print(f"Modell: {model_path}")
    print("-" * 60)

    result = transcribe(audio_path, model_path=model_path)

    print(f"\nSpråk: {result.language} (sannolikhet: {result.language_probability:.2f})")
    print(f"Ljudlängd: {result.audio_duration:.1f} sek")
    print(f"Processtid: {result.processing_time:.1f} sek")
    print(f"Antal segment: {len(result.segments)}")
    print(f"Realtidsfaktor: {result.processing_time / result.audio_duration:.2f}x")
    print("=" * 60)

    for i, seg in enumerate(result.segments, 1):
        print(f"\n[{seg.start:.1f}s - {seg.end:.1f}s] Segment {i}:")
        print(f"  {seg.text}")
        if seg.words:
            avg_conf = sum(w.confidence for w in seg.words) / len(seg.words)
            print(f"  (medelkonfidens: {avg_conf:.2f}, {len(seg.words)} ord)")

    print("\n" + "=" * 60)
    print("KLART!")


if __name__ == "__main__":
    main()
