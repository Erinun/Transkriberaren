# Changelog

## [0.4.0] — 2026-03-23

### Nya funktioner
- Kanalbaserad talarseparering for stereoinspelningar (mikrofon + systemljud)
- Bleed-subtrahering med FFT-baserad fordrojningskompensation
- Paus och ateruppta inspelning
- Modellalternativ Tiny och Base i GUI och CLI

### Forbattringar
- Standardmodell andrad: kb-whisper-small -> kb-whisper-base (2x snabbare)
- Smart CPU-tradning: 2 workers pa 8+ karnor
- Prestandaoptimering: batch_size=32 for snabb profil
- Modellval i Installningar synkas till inspelningsfloodet
- Installningar sammanfogas med defaults vid uppgradering
- Navigation: Spela in flyttad fore Transkribera

### Buggfixar
- Modellval synkades inte mellan Installningar och inspelning
- Output-katalog ateranvands fran inspelningsinstallningar
- Tydligare felmeddelande nar Tauri API saknas i inspelningsvyn
- Fixa diarize API, offline-modelldiagnostik och WeSpeaker-bundling

### Bygg och distribution
- download_models.py laddar ned tiny+base+small (alla tre vanligaste)
- sidecar_entry.py validerar dynamiskt alla bundlade whisper-modeller
- Nytt build_zip.ps1-skript for komplett release-paketering

## [0.3.0] — 2025-12-15

Forsta publika release med Tauri desktop-app (MVP).
