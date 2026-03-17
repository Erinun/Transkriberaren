# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the MötesSkribent sidecar executable.

Usage:
    pyinstaller sidecar.spec --noconfirm

Models are NOT included here — they are copied in separately by the build script
to avoid PyInstaller trying to process them.
"""

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

block_cipher = None

# --- Collect packages that have complex data/submodule structures ---

# diarize ecosystem (Silero VAD + WeSpeaker ONNX + spectral clustering)
diarize_datas, diarize_bins, diarize_hiddens = collect_all("diarize")
silero_datas, silero_bins, silero_hiddens = collect_all("silero_vad")
wespeaker_datas, wespeaker_bins, wespeaker_hiddens = collect_all("wespeakerruntime")
onnxruntime_datas, onnxruntime_bins, onnxruntime_hiddens = collect_all("onnxruntime")

# faster-whisper (includes CTranslate2 bindings)
fw_datas, fw_bins, fw_hiddens = collect_all("faster_whisper")
ct2_datas, ct2_bins, ct2_hiddens = collect_all("ctranslate2")

# torch data files (shared libraries, etc.)
torch_datas = collect_data_files("torch")
torchaudio_datas = collect_data_files("torchaudio")

# All motesskribent submodules
ms_hiddens = collect_submodules("motesskribent")

# huggingface_hub (needed for model loading)
hf_datas, hf_bins, hf_hiddens = collect_all("huggingface_hub")

all_datas = (
    diarize_datas
    + silero_datas
    + wespeaker_datas
    + onnxruntime_datas
    + fw_datas
    + ct2_datas
    + torch_datas
    + torchaudio_datas
    + hf_datas
)

all_binaries = (
    diarize_bins
    + silero_bins
    + wespeaker_bins
    + onnxruntime_bins
    + fw_bins
    + ct2_bins
    + hf_bins
)

all_hiddenimports = (
    diarize_hiddens
    + silero_hiddens
    + wespeaker_hiddens
    + onnxruntime_hiddens
    + fw_hiddens
    + ct2_hiddens
    + hf_hiddens
    + ms_hiddens
    + [
        # Explicit imports that hooks may miss
        "torchaudio.functional",
        "torchaudio.transforms",
        "soundfile",
        "numpy",
        "yaml",
        "rich",
        "click",
    ]
)

a = Analysis(
    ["sidecar_entry.py"],
    pathex=["src"],  # so 'motesskribent' package is found
    binaries=all_binaries,
    datas=all_datas,
    hiddenimports=all_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "PIL",
        "IPython",
        "jupyter",
        "notebook",
        "pytest",
        "sphinx",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # one-dir mode
    name="motesskribent-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,  # UPX can cause issues with torch DLLs
    console=True,  # needs stdin/stdout for IPC
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="motesskribent-sidecar",
)
