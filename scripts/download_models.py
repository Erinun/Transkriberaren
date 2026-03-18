"""Download all ML models for offline bundling.

Run once at build time:
    python scripts/download_models.py

No HF_TOKEN needed — all models are publicly available.
"""

import shutil
import sys
from pathlib import Path

# Resolve paths relative to project root (one level up from scripts/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = str(PROJECT_ROOT / "models" / "hub")


def _resolve_symlinks(directory: Path) -> int:
    """Replace all symlinks under directory with copies of their target files.

    HuggingFace Hub uses symlinks in snapshots/<hash>/ pointing to blobs/<hash>.
    These break when copied by PowerShell Copy-Item or packaged by NSIS.
    Replacing them with real file copies ensures the bundled models work offline.

    Returns the number of symlinks resolved.
    """
    resolved = 0
    for p in directory.rglob("*"):
        if p.is_symlink():
            target = p.resolve()
            if not target.exists():
                print(f"  VARNING: Bruten symlink: {p} -> {target}")
                continue
            # Remove symlink and copy the real file
            p.unlink()
            if target.is_dir():
                shutil.copytree(target, p)
            else:
                shutil.copy2(target, p)
            resolved += 1
    return resolved


def _verify_no_symlinks(directory: Path) -> list[Path]:
    """Return a list of any remaining symlinks under directory."""
    return [p for p in directory.rglob("*") if p.is_symlink()]


def main():
    from huggingface_hub import snapshot_download

    print(f"Cache-katalog: {CACHE_DIR}")
    print()

    # 1. KB-Whisper (CTranslate2 format, ~500 MB) — public, no token needed
    #    Only download files needed by faster-whisper (CTranslate2 format).
    #    Skip PyTorch, SafeTensors, GGML, ONNX variants (~8 GB savings).
    print("[1/3] Laddar ned KBLab/kb-whisper-small (enbart CTranslate2) ...")
    snapshot_download(
        "KBLab/kb-whisper-small",
        cache_dir=CACHE_DIR,
        allow_patterns=[
            "config.json",
            "model.bin",
            "tokenizer.json",
            "vocabulary.*",
            "preprocessor_config.json",
            "special_tokens_map.json",
            "added_tokens.json",
            "README.md",
        ],
        ignore_patterns=[
            "*.safetensors",
            "*.gguf",
            "ggml-*",
            "onnx/*",
            "onnx/**",
            "flax_model*",
            "tf_model*",
            "opus-mt-*",
            "pytorch_model*",
        ],
    )
    print("  OK")

    # 2. Diarize-modeller (Silero VAD + WeSpeaker ONNX) — auto-downloaded
    print("[2/3] Laddar ned diarize-modeller (Silero VAD + WeSpeaker) ...")
    sys.path.insert(0, str(PROJECT_ROOT / "src"))
    from motesskribent.diarization.diarizer import _warmup_models
    _warmup_models()
    print("  OK")

    # 3. Replace symlinks with real file copies (critical for NSIS packaging)
    print("[3/3] Ersätter symlinks med riktiga filer...")
    hub_dir = Path(CACHE_DIR)
    resolved = _resolve_symlinks(hub_dir)
    print(f"  {resolved} symlinks ersatta")

    remaining = _verify_no_symlinks(hub_dir)
    if remaining:
        print(f"  VARNING: {len(remaining)} symlinks kvarstår!")
        for p in remaining:
            print(f"    {p}")
    else:
        print("  Verifierat: inga symlinks kvarstår")

    print()
    print("Alla modeller nedladdade!")
    print(f"Katalog: {CACHE_DIR}")

    # Print total size
    total = sum(f.stat().st_size for f in Path(CACHE_DIR).rglob("*") if f.is_file())
    print(f"Total storlek: {total / (1024**3):.2f} GB")


if __name__ == "__main__":
    main()
