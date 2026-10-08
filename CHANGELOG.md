# Changelog

## [0.7.0] — 2026-10-08

### Nya funktioner
- Pianissimo från Klang är ny standardmotor för transkribering (lokal, svensk, CC BY 4.0). KB-Whisper finns kvar som val och används automatiskt som reserv om Pianissimo inte kan köras.
- Motorval under Inställningar; resultatvyn visar vilken motor som användes.
- Fjärrdeltagare i inspelningar skiljs åt (Talare 2, 3 …) när antal talare är Auto eller 3+.
- AI-bearbetning mot OpenAI-kompatibla tjänster, med Berget AI som förval. API-nyckeln sparas i Windows nyckelförvaring. Avstängt tills det aktiveras.

### Borttaget
- Ollama-kopplingen. Tidigare Ollama-inställningar flyttas till "Egen server" (http://localhost:11434/v1) och behöver aktiveras en gång.

### Bygg och distribution
- Python 3.11 krävs. onnx-asr tillagt; Pianissimo int8 (~660 MB) ingår i installationen.

## [0.5.0] — 2026-03-31

### Nya funktioner
- Transkriptioner-knapp i navigeringsfältet
- Förbättrad startsida med informationstext och feedback-länk

### Buggfixar
- Fixa stale closure vid sparning av Ollama-resultat
- Ta bort Medium och Large från modellinformation

### Bygg och distribution
- Admin-fri installer: byt från offline-installer till WebView2 bootstrapper (~1.8 MB)
- Minskad installationsstorlek (~158 MB mindre)
- Synkade versionsnummer i alla konfigurationsfiler

## [0.4.3] — 2026-03-27

### Bygg och distribution
- Fixa CI-pipeline: `--bundles none` → `--no-bundle` (tauri-cli v2)
- Fixa build_zip.ps1: peka på Inno Setup output istället för NSIS
- WebView2 tre-stegs felhantering i installern
- Uppdatera INSTALLATION.md: ta bort NSIS-referens

## [0.4.2] — 2026-03-27

### Buggfixar
- Fixa Ollama-timeout: separata connect_timeout och idle_timeout per chunk
- Auto-justering av num_ctx för stora transkriberingar

### Bygg och distribution
- Byt från NSIS till Inno Setup-installer (NSIS 32-bit kraschar på payloads >1.8 GB)
- WebView2-bootstrapper ingår i installern
- Per-user-installation (inget admin-konto krävs)

## [0.4.1] — 2026-03-26

### Förbättringar
- Mötesdetektering startar automatiskt vid app-start om den var aktiverad
- Robust Teams-fönster-heuristik istället för keyword-matchning
- Ollama-genereringsparametrar (temperatur, kontextfönster, max tokens) åter i Inställningar

### Buggfixar
- Fixa zip-filnamn i installationsdokumentation

## [0.4.0] — 2026-03-24

### Nya funktioner
- Kanalbaserad talarseparering för stereoinspelningar (mikrofon + systemljud)
- Bleed-subtrahering med FFT-baserad fördröjningskompensation
- Paus och återuppta inspelning
- Modellalternativ Tiny och Base i GUI och CLI

### Förbättringar
- Standardmodell ändrad: kb-whisper-small -> kb-whisper-base (2x snabbare)
- Smart CPU-trådning: 2 workers på 8+ kärnor
- Prestandaoptimering: batch_size=32 för snabb profil
- Modellval i Inställningar synkas till inspelningsflödet
- Inställningar sammanfogas med defaults vid uppgradering
- Navigation: Spela in flyttad före Transkribera

### Buggfixar
- Modellval synkades inte mellan Inställningar och inspelning
- Output-katalog återanvänds från inspelningsinställningar
- Tydligare felmeddelande när Tauri API saknas i inspelningsvyn
- Fixa diarize API, offline-modelldiagnostik och WeSpeaker-bundling

### Bygg och distribution
- download_models.py laddar ned tiny+base+small (alla tre vanligaste)
- sidecar_entry.py validerar dynamiskt alla bundlade whisper-modeller
- Nytt build_zip.ps1-skript för komplett release-paketering

## [0.3.0] — 2025-12-15

Första publika release med Tauri desktop-app (MVP).
