"""Entry point for the PyInstaller-bundled sidecar executable.

Sets HF environment variables to point at bundled models BEFORE any imports
that might trigger model downloads, then starts the persistent server.
"""

import os
import shutil
import sys

# When running as a PyInstaller one-dir exe, sys.executable points to
# dist/motesskribent-sidecar/motesskribent-sidecar.exe.
# Models are in dist/motesskribent-sidecar/models/.
exe_dir = os.path.dirname(sys.executable)
models_dir = os.path.join(exe_dir, "models")

# Diagnostik till stderr (stdout = IPC, får ej röras)
print(f"[sidecar] sys.executable: {sys.executable}", file=sys.stderr)
print(f"[sidecar] exe_dir: {exe_dir}", file=sys.stderr)
print(f"[sidecar] models_dir: {models_dir} (exists={os.path.isdir(models_dir)})", file=sys.stderr)

if os.path.isdir(models_dir):
    os.environ["HF_HOME"] = models_dir
    os.environ["HF_HUB_CACHE"] = os.path.join(models_dir, "hub")
    os.environ["HF_HUB_OFFLINE"] = "1"

    # Kontrollera att den förväntade modellkatalogen finns
    whisper_model_dir = os.path.join(
        models_dir, "hub", "models--KBLab--kb-whisper-small"
    )
    if os.path.isdir(whisper_model_dir):
        print(f"[sidecar] Whisper-modell hittad: {whisper_model_dir}", file=sys.stderr)
    else:
        print(
            f"[sidecar] VARNING: Whisper-modellkatalog saknas: {whisper_model_dir}",
            file=sys.stderr,
        )

    # Auto-reparera brutna symlinks vid uppstart
    hub_dir = os.path.join(models_dir, "hub")
    if os.path.isdir(hub_dir):
        broken_count = 0
        repaired_count = 0
        for root, dirs, files in os.walk(hub_dir):
            for name in files + dirs:
                full_path = os.path.join(root, name)
                if os.path.islink(full_path) and not os.path.exists(full_path):
                    broken_count += 1
                    # Try to find the blob target
                    target = os.readlink(full_path)
                    target_name = os.path.basename(target)
                    # Walk up to find blobs/ sibling directory
                    parts = full_path.split(os.sep)
                    # Look for blobs/ at the model cache level
                    for i, part in enumerate(parts):
                        if part == "snapshots" and i > 0:
                            blobs_dir = os.sep.join(parts[:i]) + os.sep + "blobs"
                            blob_file = os.path.join(blobs_dir, target_name)
                            if os.path.isfile(blob_file):
                                os.unlink(full_path)
                                shutil.copy2(blob_file, full_path)
                                repaired_count += 1
                                print(
                                    f"[sidecar] Reparerade bruten symlink: {full_path}",
                                    file=sys.stderr,
                                )
                            break

        if broken_count > 0:
            print(
                f"[sidecar] Symlink-status: {broken_count} brutna, {repaired_count} reparerade",
                file=sys.stderr,
            )
        else:
            print("[sidecar] Inga brutna symlinks hittade", file=sys.stderr)
else:
    print("[sidecar] VARNING: models/ saknas — kör i dev-läge?", file=sys.stderr)

# Also ensure PYTHONIOENCODING is set for Windows
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

print(
    f"[sidecar] HF_HOME={os.environ.get('HF_HOME', '<ej satt>')}, "
    f"HF_HUB_CACHE={os.environ.get('HF_HUB_CACHE', '<ej satt>')}, "
    f"HF_HUB_OFFLINE={os.environ.get('HF_HUB_OFFLINE', '<ej satt>')}",
    file=sys.stderr,
)

from motesskribent.server import run_server  # noqa: E402

run_server()
