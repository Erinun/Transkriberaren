"""Entry point for the PyInstaller-bundled sidecar executable.

Sets HF environment variables to point at bundled models BEFORE any imports
that might trigger model downloads, then starts the persistent server.
"""

import os
import sys

# When running as a PyInstaller one-dir exe, sys.executable points to
# dist/motesskribent-sidecar/motesskribent-sidecar.exe.
# Models are in dist/motesskribent-sidecar/models/.
exe_dir = os.path.dirname(sys.executable)
models_dir = os.path.join(exe_dir, "models")

if os.path.isdir(models_dir):
    os.environ["HF_HOME"] = models_dir
    os.environ["HF_HUB_CACHE"] = os.path.join(models_dir, "hub")
    os.environ["HF_HUB_OFFLINE"] = "1"

# Also ensure PYTHONIOENCODING is set for Windows
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

from motesskribent.server import run_server  # noqa: E402

run_server()
