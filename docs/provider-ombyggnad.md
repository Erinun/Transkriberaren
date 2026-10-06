# Provider-ombyggnad av MötesSkribent – Fas 0: kartläggning

*Datum: 2026-10-06. Gren: `claude/friendly-goodall-eb8ran` (samma commit som `main`, `5811da9`, v0.6.1). Arbetskatalogen var ren före och efter kartläggningen. Inga filer utom den här rapporten har ändrats.*

## Sammanfattning

- Grunden stämmer med din beskrivning: Tauri 2, Python-sidecar, faster-whisper med KB-Whisper och WASAPI loopback. **Tre saker skiljer sig dock på sätt som påverkar planen:**
  1. **Talarsepareringen använder inte pyannote.** Den använder biblioteket `diarize` (Silero VAD + WeSpeaker ONNX + spektral klustring), och **inspelningar från appen använder den inte alls**. De spelas in i stereo (vänster = mikrofon, höger = systemljud), varje kanal transkriberas för sig, och talarna blir "Talare 1" (du) och "Talare 2" (alla andra i mötet). `diarize` körs bara på importerade ljudfiler.
  2. **Det finns redan en LLM-koppling**: Ollama via Rust (`src-tauri/src/ollama.rs`) med promptmallar och sparade resultat per möte.
  3. **Inspelningen sparas inte.** Den temporära WAV-filen raderas efter transkriberingen, och historiken ligger i `localStorage` (max 5 möten, bara Markdown-texten).
- **Provet av Pianissimo kunde inte köras.** Containerns nätverkspolicy blockerar `huggingface.co` och `api.berget.ai` (svaret blir 403), så ingen modell går att hämta, varken Pianissimo eller KB-Whisper. Repot innehåller dessutom ingen svensk ljudfil. Ett färdigt mätskript finns i [bilaga A](#bilaga-a-mätskript).
- **`onnx-asr` går att lägga till utan konflikt.** onnxruntime 1.30.0 finns redan via faster-whisper och wespeakerruntime. Men `onnx-asr` 0.12.0 **utesluter uttryckligen onnxruntime 1.24.1**, alltså den version modellkortet mätte med.
- **Ordlista (phrase boosting) finns inte i `onnx-asr`.** Avkodningen är girig och API:t har inget sätt att skicka med en ordlista. Tidsstämplar och uppdelning vid pauser **går** däremot att kombinera.
- 135 enhetstester passerar och frontend bygger. Rust-delen går inte att kompilera i den här Linux-containern.

---

## 1. Hur appen fungerar idag

### 1.1 Struktur och versioner

| Del | Teknik | Var |
|---|---|---|
| Frontend | React 19, TypeScript 5.6, Vite 6, Tailwind 4 | `app/` |
| Skal | Tauri 2 (Rust 2021), reqwest 0.12 (rustls), cpal 0.15, hound 3.5, `windows` 0.58 | `src-tauri/` |
| Pipeline | Python ≥3.10 (CI och release kör **3.11**), faster-whisper ≥1.1 (låses till 1.2.1), `diarize` 0.1.0, torch/torchaudio (CPU), soundfile, python-docx | `src/motesskribent/` |
| Paketering | PyInstaller (one-dir) → `src-tauri/sidecar/` → Tauri `--no-bundle` → **Inno Setup** (inte Tauri/NSIS) | `sidecar.spec`, `scripts/*.ps1`, `scripts/installer.iss`, `.github/workflows/release.yml` |
| Uppdatering | `tauri-plugin-updater` mot GitHub Releases (`latest.json`) | `tauri.conf.json`, `UpdateChecker.tsx` |

**Kommunikation:**

```
React ──invoke()──▶ Rust-kommandon (commands.rs)
                      │
                      ├─ SidecarManager: håller en Python-process igång
                      │   (bundlad motesskribent-sidecar.exe i release,
                      │    python -m motesskribent serve i dev)
                      │   stdin  ◀─ NDJSON-kommandon {request_id, command, config}
                      │   stdout ─▶ progress / result / error / end
                      │   stderr ─▶ Rust-loggen (debug)
                      │   reserv: engångskörning med --json-ipc (sidecar.rs)
                      │
                      ├─ ollama.rs: HTTP till Ollama, strömmar tokens som "ollama-event"
                      └─ audio_capture.rs + wasapi_loopback.rs: inspelning
Rust ──emit("pipeline-event" / "ollama-event")──▶ React-hooks (usePipeline, useOllama)
```

Sidecarn har kommandona `ping`, `warmup`, `transcribe` och `shutdown`. Den behandlar ett kommando i taget. Vid start skickar Rust `warmup` med **hårdkodad** modell `KBLab/kb-whisper-base` (`lib.rs`), eftersom användarens val bara finns i frontendens `localStorage`. Timeout: 180 s för warmup, längre för transkribering.

### 1.2 Ljud

- **Fångst** (`audio_capture.rs`, bara Windows): mikrofonen läses via cpal och systemljudet via egen WASAPI-loopback (`wasapi_loopback.rs`). Båda mixas ner till mono per källa.
- **Format:** **stereo-WAV, 16 bit PCM, med mikrofonens samplingsfrekvens** (oftast 48 kHz). Vänster kanal är mikrofon, höger kanal systemljud. Loopback-ljudet resamplas linjärt till mikrofonens frekvens om de skiljer sig.
- **Lagring:** `%TEMP%/motesskribent_rec_<tid>.wav`, som **raderas efter transkriberingen** (`commands.rs::run_transcription`).
- **Lägen:** `headphones` och `speakers`. Båda spelar in mikrofon och systemljud.
- **Förbehandling** (`preprocessor.py`): läses med `soundfile` och resamplas till 16 kHz med `torchaudio.functional.resample`. Ut kommer en mono-fil och, vid stereo, separata `_mic_16k.wav` och `_system_16k.wav`. Silero VAD (via faster-whisper) räknar ut tal- och tystnadsstatistik.

### 1.3 Transkribering

- `transcription/transcriber.py`: `WhisperModel` / `BatchedInferencePipeline` på CPU med `compute_type=int8`. Modellen cachas per process. Trådning: ¾ av kärnorna, 2 workers från 8 kärnor.
- **Inställningar** (`pipeline.py`, `SPEED_PROFILES`):
  - `fast`: beam 1, batch 32, ingen VAD-statistik
  - `balanced` (standard): beam 1, batch 16
  - `quality`: beam 5, batch 8
  - Alltid: `language="sv"`, `vad_filter=True` (min_silence 500 ms, pad 200 ms)
  - Ordtidsstämplar är **avstängda** i alla profiler, eftersom `include_word_timestamps` är False som standard.
  - `initial_prompt` finns i pipelinen men frontend skickar alltid `null`.
- **Modeller:** `KBLab/kb-whisper-tiny`, `-base` (standard) och `-small` i CTranslate2-format, bundlade och offline (`HF_HUB_OFFLINE=1`). `_resolve_model_path` letar upp snapshot-katalogen manuellt.
- **Resultatets form:**
  ```python
  TranscriptionResult(segments: list[TranscribedSegment], language, language_probability,
                      processing_time, model_name, audio_duration)
  TranscribedSegment(text, start, end, words: list[TranscribedWord], speaker_id, speaker_label)
  TranscribedWord(word, start, end, confidence)   # confidence = faster-whispers 'probability'
  ```
  Texten tvättas från skräptecken (`clean_transcription_text`). Progress rapporteras per segment via `progress_callback(index, seg.end, duration)`.
- **Kod som läser resultatet:**
  - `pipeline._assign_speakers`
  - `channel_diarizer.merge_channel_transcriptions` / `_deduplicate_bleed` (text, start, end, speaker)
  - `formatter.merge_short_segments`, `to_markdown`, `to_json`, `to_docx`
  - `server._handle_transcribe` och `cli._run_json_ipc`, som serialiserar till IPC (`start, end, speaker_id, speaker_label, text` plus `md_content`, `model_name`, `word_count`, `summary`)
  - Frontend: `usePipeline`, `ResultView` (segmentvy och Markdown-vy) och `lib/generateDocx.ts`

### 1.4 Talarseparering

| Källa | Metod | Talare |
|---|---|---|
| Importerad fil (mono eller annat än 2 kanaler) | `diarize`: VAD → WeSpeaker-embeddings → spektral klustring, sedan egen sammanslagning av lika röster (cosinus ≥ 0,55) och korta segment (< 1,5 s). Körs **parallellt** med transkriberingen. | "Talare 1…N" i ordning efter första replik. Varje transkriptsegment kopplas till det diariseringssegment som överlappar mest i tid. |
| Inspelning i appen (alltid stereo) | **Kanalbaserad**: varje kanal transkriberas för sig. Mikrofonsegment blir Talare 1 och systemsegment Talare 2. Mikrofonläckage tas bort med tidsöverlapp + textlikhet (`difflib` ≥ 0,6). | Alltid högst 2 |
| `num_speakers ≤ 1` | Hoppar över diarisering | Talare 1 |

Om diariseringen misslyckas körs pipelinen ändå och lägger till varningen "Talarseparering ej tillgänglig". Ingen HF-token behövs.

### 1.5 Transkript: datamodell, lagring och export

- **Python** skriver filer till utdatakatalogen (standard `Dokument/MötesSkribent`): `<namn>.md` (svenskt protokoll: "**[MM:SS] Talare N:**"), `<namn>.json` (`metadata`, `speakers`, `segments` och eventuellt `words`) och `<namn>.docx` om det valts. Segment från samma talare med glapp under 2 s slås ihop innan dess.
- **Frontend-historik** (`useHistory.ts`): `localStorage["motesskribent-history"]`, **max 5 poster**. Varje post innehåller `mdContent`, `summary`, `modelName`, `wordCount` och `ollamaResults[]`. Segmenten sparas **inte**, och historikvyn visar bara Markdown. När lagringen blir full rensas Ollama-resultat i äldre poster.
- **Export från resultatvyn:** Markdown, och DOCX genererad i frontend med `docx`-biblioteket, båda via Rust-kommandona `write_text_to_file` / `write_binary_to_file`.

### 1.6 Inställningar

- Allt ligger i `localStorage`:
  - `motesskribent-settings` (modell, antal talare, format, VAD, hastighetsprofil)
  - `motesskribent-ollama-url`, `-ollama-model`, `-ollama-options`
  - promptmallar, mötesdetektering och ljudlägesval per enhet
- `SettingsView.tsx` är en enda lång sida med sektionerna:
  - Standardmodell (Tiny/Base/Small med info)
  - Antal talare, format, hastighetsprofil, VAD
  - **Ollama (lokal LLM)**: URL, hälsokontroll, modellval och parametrar
  - Promptmallar
  - Mötesdetektering
- Varje ändring sparas direkt. `loadSettings` **återställer okända modell-ID:n till base**. Det måste ändras när nya motorer läggs till.
- **Det finns ingen nyckelförvaring idag.** Inget i appen hanterar hemligheter.

### 1.7 AI-funktioner idag

- `ollama.rs`:
  - `GET {url}/api/tags` för modellistan
  - `POST {url}/api/generate` med strömning, avbrott och 5 minuters timeout utan aktivitet
  - Höjer `num_ctx` automatiskt om prompten är för lång (cirka 4 tecken per token, max 131 072)
- Fem promptmallar (`data/promptTemplates.ts`): Sammanfattning, Åtgärdspunkter, Mötesprotokoll, Renskrivning och Egen prompt. Svaret är fri Markdown, utan strukturerat format och utan uppdelning av långa transkript.
- Resultaten sparas per mall i historikposten.
- Ollama-servern kan vara fjärr (URL är fritt fält), men det står "lokal LLM" i gränssnittet.

### 1.8 Paketering och modeller

- `scripts/download_models.py` laddar ner KB-Whisper tiny/base/small (bara CTranslate2-filer) och WeSpeaker-ONNX vid **byggtid**. Symlänkar ersätts med riktiga filer.
- Modellerna kopieras till `dist/motesskribent-sidecar/models/` och följer med i installationen. Appen kör helt offline.
- `sidecar_entry.py` sätter `HF_HOME`, `HF_HUB_CACHE` och `HF_HUB_OFFLINE=1`, patchar WeSpeakers modellsökväg och validerar modellerna. `sidecar_manager.rs` sätter samma variabler som extra säkerhet.
- CI cachar `models/` med nyckeln `hashFiles('scripts/download_models.py')`.
- Inno Setup valdes för att NSIS (32-bit) kraschade på paket över 1,8 GB. **Installationen är alltså redan över 1,8 GB okomprimerad.**

### 1.9 Beroenden

Upplöst för Python 3.11 med `uv pip compile` mot PyPI (den här maskinen):

| Paket | Version idag | Med `onnx-asr[cpu,hub]` |
|---|---|---|
| onnxruntime | **1.30.0** (via faster-whisper, wespeakerruntime) | 1.30.0, oförändrad |
| onnx-asr | – | 0.12.0 (enda tillägget) |
| numpy | 2.4.6 | 2.4.6 |
| huggingface-hub | 1.33.0 | 1.33.0 |
| torch / torchaudio | 2.14.1 / 2.11.0 | oförändrade |

- **Ingen konflikt.** Den befintliga motorn behöver inte uppgraderas.
- `onnx-asr` 0.12.0 kräver `onnxruntime>=1.18.1, !=1.24.1, !=1.25.*, !=1.26.0`. Om vi tvingar fram 1.24.1 väljer upplösaren i stället den äldre `onnx-asr` 0.11.0. Rekommendation: behåll 1.30.0 som redan bundlas.
- På **Python 3.10** begränsar `onnx-asr` onnxruntime till `<1.24`. `requires-python` bör därför höjas till `>=3.11`, vilket CI och release redan kör.
- `onnx-asr` 0.12.0 importerades tillsammans med appens beroenden, och hela testsviten kördes med paketet installerat.
- PyTorch behövs fortfarande för resampling och för `silero-vad`/`diarize`. Pianissimo tar alltså inte bort torch ur installationen.

### 1.10 Körbarhet

| | Status här (Linux-container, 4 vCPU Intel Xeon 2,8 GHz, 15 GB RAM) |
|---|---|
| `pytest tests/ -m "not integration"` | **135 passerade**, 4 bortvalda (Python 3.11 venv i scratch) |
| `npm run build` (tsc + vite) | OK |
| Rust (`cargo check`) | **Går inte här.** webkit2gtk saknas, och `sidecar_manager.rs` använder `libc::kill` utanför Windows utan att `libc` är ett beroende. Rust-delen kompilerar alltså bara på Windows (CI-jobbet `rust-check-windows` kör check + clippy men inte `cargo test`). |
| WASAPI / inspelning / `cargo tauri dev` | Kräver Windows. Kan inte köras här. |
| Modeller | Kan inte hämtas: `huggingface.co`, `download.pytorch.org` och `api.berget.ai` blockeras av nätverkspolicyn. PyPI fungerar. |

Testerna (`tests/`) täcker formatter, pipeline (talartilldelning, progress), preprocessor, kanaldiarisering, diarizer-logik, CLI och IPC-smoketest mot `serve`. Integrationstester kräver riktiga modeller.

---

## 2. Skillnader mot din beskrivning

| Din beskrivning | Vad koden visar | Påverkan |
|---|---|---|
| pyannote-audio för talarseparering | `diarize` (FoxNoseTech, Apache 2.0): Silero VAD + WeSpeaker ONNX + spektral klustring. `CLAUDE.md` och den tekniska specifikationen nämner fortfarande pyannote och HF-token. Det är inaktuellt. | Ingen HF-token behövs. Leverantörslagret ska bara byta tal-till-text-steget. Diariseringen står kvar. |
| Talarseparering på möten | **Appens inspelningar diariseras inte med röstigenkänning.** Det blir alltid två talare: du och "systemljudet". | Mötesanteckningar kan bara ange "Talare 1/2" som ansvarig vid inspelningar. Fysiska möten med en mikrofon och flera personer blir "Talare 1" rakt igenom. |
| Ingen AI-koppling nämnd | Ollama-integration med promptmallar finns redan. | Nya AI-lagret ersätter eller utvidgar den. Ollama har ett OpenAI-kompatibelt `/v1`-API och täcks därför av "egen server-URL". Se fråga 3. |
| Python-sidecar | En PyInstaller-exe som Tauri behandlar som resurs (inte `externalBin`) och som `SidecarManager` startar. I dev körs Python-källan. | Nya Python-beroenden måste läggas in i `sidecar.spec` (`collect_all("onnx_asr")`). |
| Ljud bearbetas lokalt | Stämmer. Undantag idag: Ollama-URL:en kan peka på en fjärrserver (text), och uppdateringskontrollen kontaktar GitHub. | Inga ändringar. Noteras för "inga nya nätverksanrop". |
| | Inspelningen raderas efter transkribering. Historiken sparar bara Markdown. | "Köra om" fungerar för AI-steget (texten finns kvar) men inte för transkriberingen. |

Avvikelsen om talarseparering ändrar inte målet. Den är skälet till att jag stannar och frågar (fråga 1).

---

## 3. Provet av Pianissimo

**Status: inte genomfört.** Det finns två hinder:

1. **Nätverk.** `huggingface.co` (och därmed `KlangAI/pianissimo-sv-onnx`, `KBLab/kb-whisper-*` och `istupakov/silero-vad-onnx`) svarar 403 via miljöns proxy. Det gör även `download.pytorch.org` och `api.berget.ai`.
2. **Testfil.** Repot innehåller inga ljudfiler. Testerna skapar syntetiskt ljud (sinus eller brus), vilket inte går att använda för att bedöma transkribering.

**Vad jag kontrollerat i stället, genom att läsa källkoden i `onnx-asr` 0.12.0:**

| Fråga | Svar |
|---|---|
| Tidsstämplar + uppdelning vid pauser | **Ja.** `model.with_vad(vad).with_timestamps().recognize(wav)` ger per segment `start`, `end`, `text`, `tokens`, `timestamps` och `logprobs`. Token-tidsstämplarna är **relativa till segmentets start** och måste förskjutas med `start`. Tokens är delord (BPE), så ord får byggas ihop från tokens. |
| Segmentlängd | Silero-VAD i `onnx-asr` har som standard `max_speech_duration_s=20`, `min_silence_duration_ms=100` och `speech_pad_ms=30`. Längre tal klipps hårt var 20:e sekund, även mitt i ett ord. Parametrarna är justerbara (sätts per `with_vad(...)`). |
| Ordlista (phrase boosting) | **Nej.** Avkodningen är girig (argmax för CTC, girig sökning för transducer/TDT). `RecognizeOptions` har bara `language`, `target_language` och `pnc`. Det finns ingen parameter för hotwords, bias eller kontext. **Ingen ordlistefunktion byggs.** Se alternativ i 5.3. |
| Offline/lokal modell | `load_model(namn, path=<lokal katalog>)` sätter offline-läge när katalogen finns. Modelltypen läses från `config.json` i repot. Pianissimos typ (troligen en NeMo-variant) har jag inte kunnat se. |
| VAD-modellen | `load_vad("silero")` hämtar `istupakov/silero-vad-onnx` från HF. Den måste bundlas separat (cirka 2 MB), eftersom den inte är samma fil som Silero i faster-whisper eller i `silero-vad`-paketet. |
| Trådar | `sess_options=onnxruntime.SessionOptions()` med `intra_op_num_threads` stöds. |
| GPU / strömning | GPU via `onnxruntime-gpu` (ska inte byggas). Ingen strömmande igenkänning. Transkriberingen sker i segment, som du antog. |
| Interpunktion och versaler | Okänt utan modellen. KB-Whisper ger interpunktion. Om Pianissimo inte gör det påverkas läsbarhet och AI-steget. **Det här måste provet besvara.** |

**Mätskriptet** (bilaga A) kör Pianissimo int8 med VAD och tidsstämplar, och KB-Whisper base med appens inställningar (batch 16, beam 1, VAD), i varsin process. Det mäter laddtid, körtid, realtidsfaktor och toppminne (RSS) och sparar båda transkripten i JSON för jämförelse. Skriptet är syntaxkontrollerat mot de installerade biblioteken men inte kört.

Den här containern har samma sorts maskin som modellkortets mätning (Intel Xeon, 4 trådar) och är därför en bra jämförelsepunkt. **Det relevanta för verksamheten är ändå en vanlig Windows-laptop**, så skriptet bör köras även där.

---

## 4. Stegvis plan

### 4.1 Föreslagen ordning

| Steg | Innehåll | Varför i den ordningen |
|---|---|---|
| 1 | Leverantörsgränssnitt + KB-Whisper som första leverantör | Som du föreslog. |
| 2 | Pianissimo som lokal leverantör, med reserv till KB-Whisper | Som du föreslog. |
| **3** | **AI-leverantörslager**, inklusive nyckelförvaring | Nyckelförvaring och leverantörsinställningar behövs av både AI och fjärrtranskribering. Bygg dem en gång, för text först. |
| **4** | **Mötesanteckningar** | Ger nytta direkt med lokal transkribering. |
| **5** | **Fjärrtranskribering** | Den enda vägen där ljud lämnar datorn. Den byggs sist, ovanpå färdig nyckelhantering och samtyckesflöde, och återanvänder leverantörsmodellen. |
| 6 | Inställningssidan (Transkribering / Efterbearbetning, egna leverantörer) | Varje steg lägger till sina reglage löpande. Steg 6 gör den slutliga indelningen och lägger till egna leverantörer. |

Varje steg blir en commit och appen ska fungera efter varje steg.

### 4.2 Arkitektur

- **Transkriberingsleverantörer i Python**, där pipelinen redan kör: lokala motorer och fjärrservern. Diarisering, kanalhantering, sammanslagning och export förblir gemensamma.
- **AI-leverantörer i Rust**, intill dagens `ollama.rs`:
  - Det är bara text, så inget behöver gå via sidecarn.
  - Sidecarn kör ett kommando i taget, och ett långt LLM-anrop skulle annars blockera transkriberingar.
  - Strömning och avbrott finns redan i Rust.
- **API-nycklar i Rust** via `keyring`-craten (Windows Credential Manager):
  - Nyckeln lämnas aldrig ut till webbvyn. Frontend får bara veta "nyckel sparad: ja/nej".
  - För fjärrtranskribering läser Rust nyckeln och skickar den i kommandot till sidecarn via stdin, per anrop.
  - Python loggar aldrig `config` och maskerar `Authorization` i felmeddelanden.
- **Ljudet lämnar datorn bara om** leverantören är av fjärrtyp **och** användaren har gett ett sparat, uttryckligt samtycke för just den leverantören. Rust kontrollerar det innan kommandot skickas, så det räcker inte att frontend skickar rätt parameter.

### 4.3 Filer per steg

**Steg 1: gränssnitt + KB-Whisper (ska ge identiskt beteende)**

- Nytt: `src/motesskribent/transcription/providers/{__init__,base,registry,kb_whisper}.py`
  - `TranscriptionProvider` har `id`, `display_name`, `is_local`, `load()` och `transcribe(audio_path, options, progress_cb) -> TranscriptionResult`.
  - `kb_whisper` omsluter dagens `transcribe()` oförändrad.
- Ändras:
  - `pipeline.py`: `_run_transcription` anropar leverantören. `PipelineConfig.provider` har standardvärdet `"kb-whisper"`.
  - `server.py`: warmup och transcribe tar `provider`.
  - `cli.py`: `--motor`.
  - Resultatet får fälten `engine` och `engine_fallback`. Rust `PipelineEvent::Result` tar emot `#[serde(default)]`-fält, så äldre frontend påverkas inte.
- Tester: `tests/test_providers.py` (register, val av motor, att pipelinen anropar vald leverantör, IPC-fält).
- Verifiering före och efter: kör samma fil med commit före och efter och jämför JSON-utdata (ska vara byte-identisk bortsett från tider). **Kräver modellåtkomst.** Se fråga 2.

**Steg 2: Pianissimo**

- Nytt: `providers/pianissimo.py`
  - `onnx_asr.load_model(..., path=<models>/pianissimo-sv-onnx, quantization="int8")`
  - `with_vad(silero, max_speech_duration_s≈25, min_silence_duration_ms≈500).with_timestamps()`
  - Tokens slås ihop till `TranscribedWord` med absoluta tider, och `confidence = exp(logprob)`.
- Ändras:
  - `pipeline.py`: reserv till KB-Whisper om laddning eller körning misslyckas, med varningen "Pianissimo kunde inte köras – KB-Whisper användes".
  - `server.py`: warmup laddar bara vald motor. Reserven laddas först vid behov, så båda modellerna inte ligger i minnet samtidigt.
  - `lib.rs`: warmup-modellen ska inte vara hårdkodad. Frontend skickar vald motor, eller så sparar Rust valet.
  - `pyproject.toml`: `onnx-asr[cpu]>=0.12`, `requires-python>=3.11`.
  - `sidecar.spec`: `collect_all("onnx_asr")`.
  - `scripts/download_models.py`: Pianissimo int8-filerna + `istupakov/silero-vad-onnx`.
  - `sidecar_entry.py`: validering.
  - `SettingsView.tsx`: motorval och migrering av `validModels`.
  - `ResultView.tsx`: visar använd motor.
  - `InfoModal.tsx`: "Pianissimo av Klang (KlangAI), licens CC BY 4.0" med länk.
  - `INSTALLATION.md`, `CLAUDE.md`.
- Tester: tokens → ord och tidsförskjutning (med fejkade `onnx-asr`-resultat), reservvägen, att talartilldelning och formatter fungerar på Pianissimo-segment.
- Storlek: modellen är **+660 MB på disk**. int8-ONNX komprimeras dåligt, så installationsfilen växer **sannolikt med 550–650 MB**. Det mäts vid bygget och rapporteras.

**Steg 3: AI-leverantörslager**

- Nytt: `src-tauri/src/llm.rs` (OpenAI-kompatibel klient) och `src-tauri/src/secrets.rs` (`keyring`).
  - `GET {base}/models`: läser `data[].id` och tar med `context_length`, `max_model_len` eller liknande om fältet finns.
  - `POST {base}/chat/completions` med strömning.
  - Test av anslutning: `/models`, och om det inte fungerar ett minimalt chat-anrop.
  - Nya kommandon: `llm_list_models`, `llm_test_connection`, `llm_generate`, `llm_cancel`, `secret_set`, `secret_exists`, `secret_delete`.
- Ändras: `Cargo.toml` (`keyring`), `lib.rs`, `commands.rs`. Nytt `app/src/hooks/useLlmProvider.ts`.
- Förval "Berget AI": `https://api.berget.ai/v1`, föreslagen modell `google/gemma-4-31B-it`. Det går alltid att skriva in modell-ID för hand.
- **Avstängt tills användaren valt leverantör.** Tester: Rust-enhetstester för tolkning av `/models` (bara ID, utökade fält, felsvar) och för att nyckeln aldrig hamnar i `Debug` eller loggar.

**Steg 4: mötesanteckningar**

- Nytt: `src-tauri/src/meeting_notes.rs` (eller TS-modul, se fråga 8) och `app/src/components/MeetingNotesView.tsx`.
  - JSON-schema: `sammanfattning`, `beslut[]`, `atgardspunkter[{vad, vem, nar}]`, `oppna_fragor[]`, `amnen[]`. `vem` och `nar` blir `"okänt"` när det inte sägs.
  - `response_format: {type:"json_schema", strict:true}`. Om servern svarar 400 eller inte följer schemat används `{type:"json_object"}`, och därefter instruktion plus validering och ett nytt försök.
  - Systemprompt på svenska som uttryckligen säger: svara på svenska, bygg bara på transkriptet, hitta inte på namn eller datum.
  - **Långa transkript:** tokenbudgeten uppskattas från kontextfönstret, som hämtas från `/models` eller anges av användaren med försiktigt standardvärde. Transkriptet delas vid segmentgränser med lite överlapp. Varje del extraheras mot samma schema och slås sedan ihop i ett sista anrop som tar bort dubbletter.
- Lagring: anteckningarna sparas i historikposten (nytt fält `meetingNotes`), **tillsammans med segmenten**, och som `<namn>.anteckningar.json/.md` i utdatakatalogen. Se fråga 6. Knappen "Kör om" använder sparad text.
- Export: Markdown och DOCX (`generateDocx.ts`).

**Steg 5: fjärrtranskribering**

- Nytt: `providers/openai_compatible.py`.
  - Delar 16 kHz mono vid VAD-pauser i bitar under en storleksgräns (cirka 10 min eller 20 MB, konfigurerbart).
  - `POST {base}/audio/transcriptions` (multipart: `file`, `model`, `language=sv`, `response_format=verbose_json`, `timestamp_granularities[]=segment`).
  - Om svaret saknar segment används `json`, och då blir varje bit ett segment med bitens tider. Tiderna förskjuts per bit.
  - HTTP via `httpx` (följer med huggingface-hub 1.x) eller stdlib.
- Stereo-inspelningar: två uppladdningar (mikrofon och system). Diariseringen sker fortfarande lokalt.
- Ändras: `server.py` (tar emot nyckel i kommandot, loggar aldrig), `sidecar_manager.rs` / `commands.rs` (hämtar nyckel och kontrollerar samtycke).
- Gränssnitt: samtyckesdialog vid val, och en tydlig rad "Ljudet skickas till <namn> (<värd>)" i Transkribera-, Spela in- och bearbetningsvyerna.
- Tester: uppdelning, tidsförskjutning, båda svarsformaten och felhantering (413, 401). Använder en lokal fejkserver i pytest, så inga riktiga nätverksanrop.

**Steg 6: inställningssidan**

- `SettingsView.tsx` delas i två flikar eller sektioner: **Transkribering** (motor, KB-Whisper-modell, talare, profil, fjärrleverantörer) och **Efterbearbetning** (AI-leverantör, modell, test, promptmallar, parametrar).
- "Lägg till egen leverantör" (namn, URL, nyckel, modell). Uppgifter som inte är hemliga sparas i `localStorage`, nyckeln i nyckelförvaringen.
- Migrering: befintliga Ollama-inställningar blir leverantören "Ollama" med `http://localhost:11434/v1`, om du väljer det i fråga 3.

---

## 5. Risker

### 5.1 Tekniska

| Risk | Hantering |
|---|---|
| Pianissimos hastighet och kvalitet på en vanlig laptop är omätt. "35× realtid" gäller en Xeon-server. | Mätskriptet på din dator före steg 2. KB-Whisper finns kvar som val och reserv. |
| Minne: Pianissimo cirka 1,5 GB, plus `diarize` som körs parallellt på importerade filer, plus webbvyn. Kan bli trångt på 8 GB-datorer. | Ladda bara vald motor. Reserven laddas vid behov. Mät toppminne med parallell diarisering. |
| Interpunktion och versaler från Pianissimo är okända. | Provet. Om de saknas påverkas sammanslagning av mikrofonläckage (textlikhet) och läsbarhet. Eventuellt en enkel efterbehandling. |
| VAD i `onnx-asr` klipper vid 20 s som standard. | Höj `max_speech_duration_s` (Pianissimos maxlängd per bit behöver provas). |
| onnxruntime 1.30.0 i stället för modellkortets 1.24.1 (som `onnx-asr` uttryckligen utesluter). | Små numeriska skillnader möjliga. Provet bekräftar. |
| Installationen växer med cirka 0,6 GB, och varje uppdatering via Tauri-updatern laddar ner hela installationsfilen. Inno Setup kan kräva `DiskSpanning` över cirka 2 GB (kontrolleras vid bygget). | Mät. Om det behövs: ta bort tiny eller small, eller låt Pianissimo vara ett separat nedladdningssteg (avviker från dagens mönster, se fråga 5). |
| Warmup är hårdkodad till base, och `loadSettings` återställer okända modeller. | Åtgärdas i steg 2. |
| Rust kan inte kompileras eller testas här. CI kör check och clippy men inte `cargo test`. | Lägg till `cargo test` i `verify.yml` (Windows). Rust-ändringar verifieras via CI. |
| Inspelningar har bara två "talare". | AI-anteckningar kan inte ange vem bland fjärrdeltagarna som ska göra något. Det dokumenteras i gränssnittet. Att döpa om talare ligger utanför uppdraget, men det vore ett naturligt nästa steg. |
| Historiken (`localStorage`, max 5 poster, gräns på några MB) räcker dåligt för segment och anteckningar. | Spara även som filer. Se fråga 6. |

### 5.2 Integritet

- Fjärrtranskribering är det enda nya stället där ljud kan lämna datorn. Därför krävs uttryckligt samtycke per leverantör, kontroll i Rust och synlig märkning, och funktionen byggs sist.
- AI-lagret skickar transkriptets text, med namn och sakuppgifter, till vald server. Även det kräver ett aktivt val, och märkningen ska säga vart texten går.
- Inga nya standardanrop. Det enda befintliga utgående anropet utan användarval är uppdateringskontrollen mot GitHub. Den ändras inte.

### 5.3 Ordlista: alternativ

Eftersom `onnx-asr` saknar phrase boosting föreslår jag en **termlista under Efterbearbetning** som skickas med till AI-steget: "Följande namn och termer kan förekomma, korrigera stavningen när det tydligt avses: …". KB-Whisper kan dessutom få samma lista som `initial_prompt` (stöds redan i pipelinen men används inte av gränssnittet). Det byggs först om du vill.

---

## 6. Öppna frågor till dig

1. **Avvikelsen om talarseparering:** godtar du att planen bygger på dagens `diarize` och kanalbaserad separering, och att inspelningar bara får två talare? Eller vill du att röstbaserad diarisering även körs på inspelningar (utanför uppdraget enligt mig)?
2. **Provet:** hur vill du göra?
   - **a)** Öppna nätverket i miljöns inställningar (Network access → Custom, lägg till `huggingface.co`, `hf.co`, `cas-bridge.xethub.hf.co` och `cdn-lfs.huggingface.co`, behåll paketregistren; steg finns på https://code.claude.com/docs/en/cloud-environments#network-access) och ladda upp en svensk testfil.
   - **b)** Kör `bench_asr.py` (bilaga A) på din Windows-dator och skicka utdata.

   **Ladda inte upp riktiga mötesinspelningar hit.** Använd en inspelning utan personuppgifter, till exempel egen uppläsning eller en offentlig debatt. Jag rekommenderar b, eventuellt kompletterat med a för jämförelse mot modellkortet. Utan modellåtkomst här kan jag inte heller göra jämförelsen före och efter i steg 1. Den kan i så fall göras med samma skript på din dator.
3. **Ollama:** ska det nya OpenAI-kompatibla lagret **ersätta** Ollama-integrationen (Ollama nås via `http://localhost:11434/v1`, och inställningarna migreras), eller ska båda finnas kvar sida vid sida?
4. **Promptmallarna** (fri Markdown): ska de finnas kvar bredvid de strukturerade mötesanteckningarna?
5. **Installationsstorlek:** är cirka +0,6 GB okej? Ska KB-Whisper tiny och/eller small tas bort för att kompensera, med base kvar som reserv?
6. **Lagring:** får jag spara möten, med segment och anteckningar, som filer på disk (i appdata eller utdatakatalogen) i stället för enbart i `localStorage` med max 5 poster?
7. **Ordning:** godtar du ordningen 1, 2, AI-lager, anteckningar, fjärrtranskribering, inställningar?
8. **Placering av AI-logiken:** jag föreslår Rust (som `ollama.rs`). Nackdelen är att Rust inte kan testas i den här miljön, bara i Windows-CI. Alternativet är TypeScript i frontend, men där saknas testramverk, och nyckeln måste ändå hanteras i Rust. Okej med Rust och `cargo test` tillagt i CI?
9. **Gren:** sessionen är tilldelad grenen `claude/friendly-goodall-eb8ran`. Den skapades nyss och pekar på samma commit som `main`. Duger den som "ny gren" för ombyggnaden?
10. **Termlista till AI-steget** (5.3): vill du ha den?

---

## Bilaga A: mätskript

Kör i en tom katalog med en ren Python 3.11-miljö:

```
pip install "onnx-asr[cpu,hub]" faster-whisper soundfile psutil
python bench_asr.py testfil.wav --threads 4
```

Skriptet skriver ut laddtid, körtid, realtidsfaktor och toppminne per motor, och sparar transkripten i `testfil_bench.json`.

```python
"""Fristående jämförelse: Pianissimo (onnx-asr, int8) mot KB-Whisper (faster-whisper).

Kör varje motor i en egen process så att minnesmätningen inte blandas ihop.

    pip install "onnx-asr[cpu,hub]" faster-whisper soundfile psutil
    python bench_asr.py inspelning.wav --threads 4

Filen bör vara 16 kHz mono WAV (skriptet konverterar annars med soundfile + numpy).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import threading
import time
from pathlib import Path


def _peak_rss_sampler(stop: threading.Event, out: list[float]) -> None:
    import psutil

    proc = psutil.Process()
    peak = 0
    while not stop.wait(0.05):
        peak = max(peak, proc.memory_info().rss)
    out.append(peak / 2**20)


def _to_16k_mono(src: Path, dst: Path) -> float:
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(src), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != 16000:
        n = int(len(mono) * 16000 / sr)
        mono = np.interp(np.linspace(0, len(mono) - 1, n), np.arange(len(mono)), mono).astype("float32")
    sf.write(str(dst), mono, 16000, subtype="PCM_16")
    return len(mono) / 16000


def run_engine(engine: str, wav: str, threads: int) -> dict:
    stop, peak = threading.Event(), []
    sampler = threading.Thread(target=_peak_rss_sampler, args=(stop, peak), daemon=True)
    sampler.start()

    t0 = time.perf_counter()
    if engine == "pianissimo":
        import onnx_asr
        import onnxruntime as rt

        opts = rt.SessionOptions()
        opts.intra_op_num_threads = threads
        model = onnx_asr.load_model("KlangAI/pianissimo-sv-onnx", quantization="int8", sess_options=opts)
        vad = onnx_asr.load_vad("silero")
        load_s = time.perf_counter() - t0
        t1 = time.perf_counter()
        segs = list(model.with_vad(vad).with_timestamps().recognize(wav))
        run_s = time.perf_counter() - t1
        segments = [{"start": s.start, "end": s.end, "text": s.text} for s in segs]
        has_ts = bool(segs) and segs[0].timestamps is not None
    else:
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        model = WhisperModel("KBLab/kb-whisper-base", device="cpu", compute_type="int8", cpu_threads=threads)
        pipe = BatchedInferencePipeline(model=model)
        load_s = time.perf_counter() - t0
        t1 = time.perf_counter()
        gen, _info = pipe.transcribe(
            wav, language="sv", beam_size=1, batch_size=16, word_timestamps=False,
            vad_filter=True, vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 200},
        )
        segments = [{"start": s.start, "end": s.end, "text": s.text.strip()} for s in gen]
        run_s = time.perf_counter() - t1
        has_ts = True

    stop.set()
    sampler.join()
    return {
        "engine": engine, "load_s": round(load_s, 1), "run_s": round(run_s, 1),
        "peak_rss_mb": round(peak[0]), "num_segments": len(segments),
        "token_timestamps": has_ts, "segments": segments,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", type=Path)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--engine", choices=["pianissimo", "kb-whisper"], help=argparse.SUPPRESS)
    ap.add_argument("--wav", help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.engine:  # barnprocess
        print(json.dumps(run_engine(args.engine, args.wav, args.threads), ensure_ascii=False))
        return

    wav = args.audio.with_name(args.audio.stem + "_bench16k.wav")
    duration = _to_16k_mono(args.audio, wav)
    print(f"Ljudlängd: {duration:.1f} s, trådar: {args.threads}")

    results = []
    for engine in ("pianissimo", "kb-whisper"):
        out = subprocess.run(
            [sys.executable, __file__, str(args.audio), "--threads", str(args.threads),
             "--engine", engine, "--wav", str(wav)],
            capture_output=True, text=True, encoding="utf-8",
        )
        if out.returncode != 0:
            print(f"{engine}: FEL\n{out.stderr[-2000:]}")
            continue
        r = json.loads(out.stdout.strip().splitlines()[-1])
        r["realtime_factor"] = round(duration / r["run_s"], 1) if r["run_s"] else None
        results.append(r)
        print(f"{engine}: laddning {r['load_s']} s, körning {r['run_s']} s "
              f"({r['realtime_factor']}x realtid), toppminne {r['peak_rss_mb']} MB, "
              f"{r['num_segments']} segment")

    out_path = args.audio.with_name(args.audio.stem + "_bench.json")
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Transkript och mätvärden sparade i {out_path}")


if __name__ == "__main__":
    main()
```

Laddtiden för Pianissimo inkluderar nedladdning första gången (660 MB). Kör skriptet två gånger och använd andra körningen.
