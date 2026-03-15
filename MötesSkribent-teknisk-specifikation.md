# Teknisk Specifikation: Lokal Transkriberingslösning

## Projektnamn: MötesSkribent

**Version:** 0.1 (pilot)
**Målmiljö:** Windows 10/11, standard kommunala laptops utan GPU
**Arkitektur:** 100 % lokal körning, ingen nätverkskommunikation
**Bearbetningsmodell:** Efterbearbetning (transkribering sker efter avslutat möte)

---

## 1. ÖVERSIKT

MötesSkribent är en desktop-applikation som spelar in möten (lokalt eller via Teams) och producerar strukturerade transkriberingsfiler med automatisk talarseparering. All bearbetning sker lokalt på användarens dator. Ingen data lämnar maskinen.

### 1.1 Systemflöde

```
[Inspelning]          [Bearbetning]                    [Output]
                      (startar efter avslutat möte)

Mikrofon ──┐
           ├─→ WAV-filer ─→ VAD-filtrering ─→ pyannote diarisering ─→ faster-whisper transkribering ─→ Strukturerad fil
WASAPI ────┘              (ta bort tystnad)   (vem pratar när)        (tal → text, KB-modell)           (MD + JSON)
```

### 1.2 Två faser att bygga

Projektet byggs i två faser:

**Fas 1 — Python CLI pipeline (proof of concept)**
Validera att hela kedjan fungerar: ljudfil in → transkribering med talarseparering ut. Ingen GUI. Körs från terminal. Syftet är att testa kvalitet, hastighet och identifiera problem innan vi bygger appen.

**Fas 2 — Tauri desktop-app**
Wrappa pipelinen i en användarvänlig desktop-app med inspelningsknapp, bearbetningsstatus och resultatvy. Python-pipelinen bundlas som en sidecar-process.

---

## 2. FAS 1 — PYTHON CLI PIPELINE

Detta är det som ska byggas först. Allt annat bygger på att denna pipeline fungerar.

### 2.1 Projektstruktur

```
motesskribent/
├── pyproject.toml
├── README.md
├── src/
│   └── motesskribent/
│       ├── __init__.py
│       ├── cli.py                 # CLI-entrypoint
│       ├── pipeline.py            # Huvudorkestrering
│       ├── audio/
│       │   ├── __init__.py
│       │   ├── preprocessor.py    # Ljudförbehandling, VAD-filtrering
│       │   └── recorder.py        # Inspelning (mikrofon + WASAPI) — Fas 2
│       ├── diarization/
│       │   ├── __init__.py
│       │   └── diarizer.py        # pyannote-audio wrapper
│       ├── transcription/
│       │   ├── __init__.py
│       │   └── transcriber.py     # faster-whisper wrapper
│       └── output/
│           ├── __init__.py
│           └── formatter.py       # Formatera till MD/JSON
├── models/                        # Lokala modeller (gitignored)
│   ├── kb-whisper-medium-ct2/     # Konverterad KB-modell
│   └── pyannote/                  # pyannote-modeller
├── tests/
│   ├── test_pipeline.py
│   ├── test_diarizer.py
│   └── fixtures/
│       └── test_meeting.wav       # Testljudfil
└── output/                        # Genererade transkriberingsfiler
```

### 2.2 Beroenden och installation

**pyproject.toml:**

```toml
[project]
name = "motesskribent"
version = "0.1.0"
requires-python = ">=3.10,<3.12"
dependencies = [
    "faster-whisper>=1.1.0",
    "pyannote.audio>=3.3.0",
    "torch>=2.1.0,<2.5.0",
    "torchaudio>=2.1.0,<2.5.0",
    "onnxruntime>=1.17.0",
    "soundfile>=0.12.0",
    "numpy>=1.24.0,<2.0.0",
    "click>=8.1.0",
    "rich>=13.0.0",
]

[project.optional-dependencies]
intel = ["openvino>=2024.0.0"]

[project.scripts]
motesskribent = "motesskribent.cli:main"
```

**VIKTIGT om Python-version:** Använd Python 3.10 eller 3.11. Python 3.12+ har problem med vissa torch-versioner.

**Installation steg-för-steg:**

```bash
# 1. Skapa virtuell miljö
python -m venv .venv
.venv\Scripts\activate        # Windows

# 2. Installera PyTorch CPU-only (VIKTIGT — inte GPU-versionen)
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu

# 3. Installera projektet
pip install -e .

# 4. Acceptera pyannote-licens (kräver Hugging Face-konto)
#    Gå till: https://huggingface.co/pyannote/speaker-diarization-3.1
#    Acceptera licensvillkoren
#    Skapa en token: https://huggingface.co/settings/tokens

# 5. Spara HF-token lokalt
huggingface-cli login
# ELLER: sätt miljövariabel
set HF_TOKEN=hf_xxxxx

# 6. Ladda ner och konvertera KB-Whisper-modellen
ct2-opus-mt  # Se sektion 2.4 för konverteringskommando
```

### 2.3 KB-Whisper modellkonvertering

KB:s Whisper-modeller finns på Hugging Face som standard Whisper-modeller. De måste konverteras till CTranslate2-format för faster-whisper.

```bash
# Installera konverteringsverktyg
pip install ctranslate2

# Konvertera KB-modellen till CTranslate2-format med INT8-kvantisering
ct2-opus-mt  # Verktyget heter egentligen:
ct2-transformers-converter \
    --model KBLab/kb-whisper-medium \
    --output_dir models/kb-whisper-medium-ct2 \
    --quantization int8 \
    --copy_files tokenizer.json preprocessor_config.json

# Verifiera att konverteringen lyckades
ls models/kb-whisper-medium-ct2/
# Ska innehålla: model.bin, vocabulary.json, tokenizer.json, etc.
```

**NOTERA:** Ladda även ner small-modellen som alternativ:

```bash
ct2-transformers-converter \
    --model KBLab/kb-whisper-small \
    --output_dir models/kb-whisper-small-ct2 \
    --quantization int8 \
    --copy_files tokenizer.json preprocessor_config.json
```

### 2.4 Komponent: Ljudförbehandling (preprocessor.py)

**Syfte:** Ladda ljudfil, konvertera till rätt format, och filtrera bort tystnad via VAD.

```python
"""
Ljudförbehandling med VAD-filtrering.

Tar in en WAV/MP3/M4A-fil och producerar en förbehandlad WAV-fil
där tysta segment är borttagna, samt en tidskarta som mappar
nya tidsstämplar tillbaka till originaltiderna.

VIKTIGA KRAV:
- Output ska vara 16kHz mono WAV (Whisper-krav)
- VAD-filtrering via Silero VAD (inbyggd i faster-whisper)
- Tidskarta krävs för att kunna mappa tillbaka transkriberingens
  tidsstämplar till originalljudets tidsstämplar
"""

import soundfile as sf
import numpy as np
from dataclasses import dataclass
from pathlib import Path


@dataclass
class TimeMapping:
    """Mappar bearbetade tidsstämplar tillbaka till originaltider."""
    original_start: float
    original_end: float
    processed_start: float
    processed_end: float


@dataclass
class PreprocessedAudio:
    """Resultat från förbehandling."""
    audio_path: Path              # Sökväg till förbehandlad WAV
    sample_rate: int              # Alltid 16000
    duration_original: float      # Originalets längd i sekunder
    duration_processed: float     # Efter VAD-filtrering
    time_mappings: list[TimeMapping]  # För tidsstämpelåtermappning
    silence_removed_pct: float    # Hur mycket tystnad som togs bort


def preprocess_audio(
    input_path: Path,
    output_dir: Path,
    vad_threshold: float = 0.5,       # Silero VAD-tröskel (0.0-1.0)
    min_speech_duration: float = 0.5,  # Minsta talsegment i sekunder
    min_silence_duration: float = 0.8, # Tystnad kortare än detta behålls
    padding: float = 0.3,             # Padding runt talsegment i sekunder
) -> PreprocessedAudio:
    """
    Huvudfunktion för ljudförbehandling.

    Steg:
    1. Ladda ljudfil (stödjer WAV, MP3, M4A, OGG via soundfile/ffmpeg)
    2. Konvertera till 16kHz mono
    3. Kör Silero VAD för att identifiera talsegment
    4. Extrahera talsegment med padding
    5. Konkatenera och spara som ny WAV
    6. Skapa tidskarta för tillbakamappning

    IMPLEMENTATION NOTES:
    - Använd faster_whisper.vad för Silero VAD
      (from faster_whisper.vad import VadOptions, get_speech_timestamps)
    - Om filen redan är 16kHz mono, hoppa över konvertering
    - Behåll alltid originalfilen oförändrad
    """
    pass  # IMPLEMENTERA
```

### 2.5 Komponent: Talarseparering (diarizer.py)

**Syfte:** Identifiera vem som pratar när i en ljudfil.

```python
"""
Talarseparering med pyannote-audio.

Tar in en ljudfil och returnerar en lista med tidssegment
märkta med talar-ID.

VIKTIGA KRAV:
- Använd pyannote/speaker-diarization-3.1
- Stöd för tvåkanalsinspelning (mikrofon + system) i framtiden
- Returnera talar-ID som "Talare 1", "Talare 2" etc.
- Om mikrofon-kanal finns, märk den som "Talare 1 (lokal)"
- Kör på CPU via ONNX Runtime (inte torch GPU)

PRESTANDAOPTIMERING FÖR CPU:
- Sätt num_speakers om användaren anger det (snabbar upp)
- Använd ONNX Runtime-backend istället för standard PyTorch:
    from pyannote.audio import Pipeline
    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=HF_TOKEN
    )
    # Tvinga ONNX Runtime för CPU-prestanda
    # Se pyannote docs för ONNX-konfiguration
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass
class SpeakerSegment:
    """Ett tidssegment med identifierad talare."""
    start: float          # Starttid i sekunder
    end: float            # Sluttid i sekunder
    speaker_id: str       # T.ex. "SPEAKER_00"
    speaker_label: str    # T.ex. "Talare 1" eller "Talare 1 (lokal)"


@dataclass
class DiarizationResult:
    """Resultat från talarseparering."""
    segments: list[SpeakerSegment]
    num_speakers: int
    processing_time: float  # Sekunder


def diarize(
    audio_path: Path,
    num_speakers: int | None = None,    # None = auto-detect
    min_speakers: int = 2,
    max_speakers: int = 10,
    hf_token: str | None = None,
    model_path: Path | None = None,     # Lokal modellsökväg om redan nedladdad
) -> DiarizationResult:
    """
    Kör talarseparering på en ljudfil.

    Steg:
    1. Ladda pyannote pipeline (cachelagra modellen lokalt)
    2. Kör diarisering
    3. Konvertera pyannote Annotation till SpeakerSegment-lista
    4. Tilldela läsbara etiketter ("Talare 1", "Talare 2"...)
    5. Mergea korta segment från samma talare som ligger nära varandra
       (< 1.5 sekunder gap) för att undvika fragmentering

    IMPLEMENTATION NOTES:
    - pyannote returnerar en Annotation-objekt
    - Iterera med: for turn, _, speaker in annotation.itertracks(yield_label=True)
    - turn.start och turn.end ger tidsstämplar
    - Cacha pipeline-objektet så det inte laddas om varje gång
    """
    pass  # IMPLEMENTERA
```

### 2.6 Komponent: Transkribering (transcriber.py)

**Syfte:** Konvertera tal till text med KB:s svenska Whisper-modell.

```python
"""
Transkribering med faster-whisper och KB:s svenska modell.

VIKTIGA KRAV:
- Använd faster-whisper (INTE openai-whisper)
- KB-modellen i CTranslate2-format (konverterad enligt 2.3)
- INT8-kvantisering för CPU-prestanda
- Beam size 5 för bra kvalitet
- Stöd för segmentvis transkribering (en talare åt gången)

PRESTANDAINSTÄLLNINGAR FÖR CPU:
- compute_type="int8" (halverar minnesanvändning, dubblerar hastighet)
- cpu_threads=4 (eller os.cpu_count() // 2)
- beam_size=5 (standard, bra balans)
- vad_filter=True (hoppa över tystnad inom segment)
- language="sv" (tvinga svenska, undvik autodetektering)
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass
class TranscribedWord:
    """Ett enskilt transkriberat ord med tidsstämpel."""
    word: str
    start: float
    end: float
    confidence: float


@dataclass
class TranscribedSegment:
    """Ett transkriberat segment (typiskt en mening/fras)."""
    text: str
    start: float
    end: float
    words: list[TranscribedWord]
    speaker_id: str | None = None      # Sätts av pipeline
    speaker_label: str | None = None   # Sätts av pipeline


@dataclass
class TranscriptionResult:
    """Resultat från transkribering."""
    segments: list[TranscribedSegment]
    language: str
    language_probability: float
    processing_time: float
    model_name: str
    audio_duration: float


def transcribe(
    audio_path: Path,
    model_path: Path,                # Sökväg till CT2-konverterad modell
    model_size: str = "medium",      # "small" eller "medium"
    language: str = "sv",
    beam_size: int = 5,
    cpu_threads: int = 4,
    compute_type: str = "int8",
    word_timestamps: bool = True,    # Behövs för exakt talarmappning
    initial_prompt: str | None = None,  # Kan användas för domänspecifika termer
) -> TranscriptionResult:
    """
    Transkribera en ljudfil.

    Steg:
    1. Initiera WhisperModel med lokalt modellsökväg
    2. Kör transkribering med word_timestamps=True
    3. Samla alla segment och ord
    4. Returnera strukturerat resultat

    IMPLEMENTATION:
    from faster_whisper import WhisperModel

    model = WhisperModel(
        str(model_path),
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
    )

    segments, info = model.transcribe(
        str(audio_path),
        language=language,
        beam_size=beam_size,
        word_timestamps=word_timestamps,
        vad_filter=True,
        vad_parameters=dict(
            min_silence_duration_ms=500,
            speech_pad_ms=200,
        ),
    )

    # VIKTIGT: segments är en generator — iterera en gång och samla
    # VIKTIGT: initial_prompt kan förbättra domänspecifika termer
    #          T.ex. "Västerås stad, vård och omsorg, sjuksköterska"
    """
    pass  # IMPLEMENTERA
```

### 2.7 Komponent: Pipelineorkestrering (pipeline.py)

**Syfte:** Koppla ihop alla steg i rätt ordning.

```python
"""
Huvudpipeline som orkestrerar hela bearbetningsflödet.

Flöde:
1. Förbehandla ljud (konvertera format, VAD-filtrering)
2. Kör talarseparering (pyannote)
3. Kör transkribering (faster-whisper)
4. Mappa transkriberade segment till talare
5. Formatera och spara output

KRITISK LOGIK — Talarmappning (steg 4):
Diariseringen ger tidssegment per talare.
Transkriberingen ger tidsstämplade ord/meningar.
Dessa måste matchas ihop.

Algoritm för mappning:
- För varje transkriberat segment (med start/end-tid):
  - Hitta det diariseringssegment som har störst överlapp
  - Tilldela den talarens ID till transkriberingssegmentet
  - Vid tvetydig överlapp: använd ord-tidsstämplar för finare mappning

VIKTIGT OM TIDSKORRIGERING:
Om VAD-filtrering använts, har det förbehandlade ljudet andra
tidsstämplar än originalet. Använd PreprocessedAudio.time_mappings
för att mappa tillbaka ALLA tidsstämplar till originalljudets tid
innan output genereras. Annars stämmer inte tidsstämplarna.
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass
class PipelineConfig:
    """Konfiguration för hela pipelinen."""
    # Sökvägar
    model_path: Path                     # Sökväg till CT2-modell
    output_dir: Path = Path("output")

    # Modell
    model_size: str = "small"            # "small" för pilot, "medium" för bättre kvalitet
    language: str = "sv"
    compute_type: str = "int8"
    cpu_threads: int = 4
    beam_size: int = 5

    # VAD
    vad_enabled: bool = True
    vad_threshold: float = 0.5
    min_silence_duration: float = 0.8

    # Diarisering
    num_speakers: int | None = None      # None = auto-detect
    min_speakers: int = 2
    max_speakers: int = 10
    hf_token: str | None = None

    # Output
    output_formats: list[str] = None     # ["markdown", "json"]
    include_word_timestamps: bool = False # Inkludera ord-nivå i output
    include_confidence: bool = False      # Inkludera confidence-scores

    # Domänspecifikt
    initial_prompt: str | None = None    # Domäntermer för bättre transkribering

    def __post_init__(self):
        if self.output_formats is None:
            self.output_formats = ["markdown", "json"]


@dataclass
class PipelineResult:
    """Slutresultat från hela pipelinen."""
    output_files: list[Path]          # Genererade filer
    num_speakers: int
    total_duration: float             # Originalljudets längd
    speech_duration: float            # Faktiskt tal (efter VAD)
    processing_time: float            # Total bearbetningstid
    processing_breakdown: dict        # Tid per steg


def run_pipeline(
    audio_path: Path,
    config: PipelineConfig,
    progress_callback: callable = None,  # Callback för progress (0.0-1.0)
) -> PipelineResult:
    """
    Kör hela bearbetningspipelinen.

    Steg med ungefärlig tidsfördelning (60 min möte, CPU):
    1. Förbehandling + VAD:     ~30 sekunder  (5%)
    2. Talarseparering:         ~2-4 minuter  (30%)
    3. Transkribering:          ~3-6 minuter  (60%)
    4. Mappning + formatering:  ~5 sekunder   (5%)

    Progress callback anropas med (steg_namn, procent):
    - ("preprocessing", 0.05)
    - ("diarization", 0.35)
    - ("transcription", 0.95)
    - ("formatting", 1.0)

    FELHANTERING:
    - Om diarisering misslyckas: fortsätt utan talaridentifiering
      (märk allt som "Okänd talare")
    - Om transkribering misslyckas på ett segment: logga varning,
      markera som "[ohörbart]" i output
    - Spara alltid partiellt resultat om processen avbryts
    """
    pass  # IMPLEMENTERA
```

### 2.8 Komponent: Output-formatering (formatter.py)

**Syfte:** Skapa strukturerade filer från transkriberingen.

```python
"""
Formatera transkribering till Markdown och JSON.

MARKDOWN-FORMAT:
Ska vara direkt läsbart och redigerbart. Tänk mötesprotokoll.

JSON-FORMAT:
Maskinläsbart för vidare bearbetning (t.ex. import till andra system,
analys med Claude API, eller framtida sökindexering).
"""

# --- MARKDOWN-FORMAT ---
MARKDOWN_TEMPLATE = """# Mötesanteckningar

**Datum:** {date}
**Längd:** {duration}
**Antal talare:** {num_speakers}
**Bearbetningstid:** {processing_time}

---

{segments}

---

*Transkriberat med MötesSkribent v{version} | KB-Whisper {model_size} | Lokal bearbetning*
"""

SEGMENT_TEMPLATE = """**[{start} → {end}] {speaker_label}**
{text}
"""

# --- JSON-FORMAT ---
# Struktur:
# {
#   "metadata": {
#     "date": "2025-03-12T10:00:00",
#     "duration_seconds": 3600,
#     "speech_duration_seconds": 2400,
#     "num_speakers": 3,
#     "model": "kb-whisper-small",
#     "processing_time_seconds": 240,
#     "version": "0.1.0"
#   },
#   "speakers": [
#     { "id": "SPEAKER_00", "label": "Talare 1 (lokal)", "total_speaking_time": 1200.5 },
#     { "id": "SPEAKER_01", "label": "Talare 2", "total_speaking_time": 800.3 }
#   ],
#   "segments": [
#     {
#       "start": 75.2,
#       "end": 102.8,
#       "start_formatted": "00:01:15",
#       "end_formatted": "00:01:42",
#       "speaker_id": "SPEAKER_00",
#       "speaker_label": "Talare 1 (lokal)",
#       "text": "Vi behöver diskutera schemat för nästa vecka.",
#       "confidence": 0.94,
#       "words": [...]    # Valfritt, om include_word_timestamps=True
#     }
#   ]
# }


def format_timestamp(seconds: float) -> str:
    """Konvertera sekunder till HH:MM:SS-format."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def merge_short_segments(segments: list, max_gap: float = 2.0) -> list:
    """
    Mergea korta konsekutiva segment från samma talare.

    Om Talare 1 har tre segment på 2-3 sekunder var med < max_gap
    mellanrum, slå ihop dem till ett enda segment. Det gör outputen
    mycket mer läsbar.

    LOGIK:
    - Iterera genom segment i tidsordning
    - Om nästa segment har samma talare OCH gap < max_gap:
      → Förläng nuvarande segment, konkatenera text
    - Annars: starta nytt segment
    """
    pass  # IMPLEMENTERA


def to_markdown(result, config) -> str:
    """Generera Markdown-output."""
    pass  # IMPLEMENTERA


def to_json(result, config) -> str:
    """Generera JSON-output."""
    pass  # IMPLEMENTERA
```

### 2.9 CLI-entrypoint (cli.py)

```python
"""
CLI-interface via Click.

ANVÄNDNING:

    # Grundläggande — transkribera en inspelning
    motesskribent transkribera inspelning.wav

    # Med inställningar
    motesskribent transkribera inspelning.wav \
        --modell small \
        --talare 3 \
        --format markdown json \
        --output ./resultat/ \
        --prompt "Västerås stad, vård och omsorg, sjuksköterska"

    # Lista tillgängliga modeller
    motesskribent modeller

    # Visa systeminformation (CPU, minne, uppskattad tid)
    motesskribent info

IMPLEMENTATION:
- Använd Click för CLI-ramverk
- Använd Rich för progress-indikatorer och formaterad output
- Visa uppskattad bearbetningstid baserat på filens längd och CPU
- Vid första körning: ladda ner modeller automatiskt (med bekräftelse)
"""

import click
from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
from rich.console import Console
from pathlib import Path

console = Console()


@click.group()
def main():
    """MötesSkribent — Lokal mötesanteckning med AI."""
    pass


@main.command()
@click.argument("audio_file", type=click.Path(exists=True, path_type=Path))
@click.option("--modell", type=click.Choice(["small", "medium"]), default="small",
              help="Modellstorlek. small=snabbare, medium=bättre kvalitet")
@click.option("--talare", type=int, default=None,
              help="Antal talare (lämna tomt för autodetektering)")
@click.option("--format", "formats", type=click.Choice(["markdown", "json"]),
              multiple=True, default=["markdown", "json"])
@click.option("--output", type=click.Path(path_type=Path), default=Path("output"))
@click.option("--prompt", type=str, default=None,
              help="Domänspecifika termer för bättre transkribering")
@click.option("--no-vad", is_flag=True, help="Stäng av VAD-filtrering")
def transkribera(audio_file, modell, talare, formats, output, prompt, no_vad):
    """Transkribera en ljudfil med talarseparering."""
    # IMPLEMENTATION:
    # 1. Visa filinformation (längd, format, storlek)
    # 2. Uppskatta bearbetningstid
    # 3. Skapa PipelineConfig
    # 4. Kör pipeline med Rich progress bar
    # 5. Visa sammanfattning och sökväg till output-filer
    pass


@main.command()
def modeller():
    """Visa och hantera installerade modeller."""
    # Lista modeller i models/-katalogen
    # Visa storlek, typ (small/medium), och status
    pass


@main.command()
def info():
    """Visa systeminformation och prestandauppskattning."""
    # CPU-info, antal kärnor, tillgängligt minne
    # Uppskattad tid per 60 min möte med small/medium
    pass
```

### 2.10 Testa pipelinen

```bash
# Steg 1: Skaffa en testfil
# Spela in 2-3 minuter med din telefon där minst 2 personer pratar.
# Alternativt: använd en befintlig mötesinspelning.
# Konvertera till WAV om nödvändigt:
ffmpeg -i inspelning.m4a -ar 16000 -ac 1 test_meeting.wav

# Steg 2: Kör pipelinen
motesskribent transkribera test_meeting.wav --modell small --talare 2

# Steg 3: Verifiera output
# Kontrollera:
# - Är transkriberingen korrekt svenska?
# - Identifieras talarna rätt?
# - Stämmer tidsstämplarna med originalljudet?
# - Hur lång tid tog bearbetningen?

# Steg 4: Testa med medium-modellen för kvalitetsjämförelse
motesskribent transkribera test_meeting.wav --modell medium --talare 2
```

---

## 3. FAS 2 — TAURI DESKTOP-APP

Byggs EFTER att Python-pipelinen fungerar tillfredsställande.

### 3.1 Projektstruktur

```
motesskribent-app/
├── src-tauri/                   # Rust-backend
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs
│   │   ├── audio_capture.rs     # WASAPI + mikrofon
│   │   ├── sidecar.rs           # Kommunikation med Python-process
│   │   └── commands.rs          # Tauri IPC-kommandon
│   └── binaries/                # Bundlad Python-sidecar (PyInstaller exe)
├── src/                         # React frontend
│   ├── App.tsx
│   ├── components/
│   │   ├── RecordingView.tsx    # Inspelningsvy
│   │   ├── ProcessingView.tsx   # Bearbetningsvy med progress
│   │   ├── ResultView.tsx       # Visa transkribering
│   │   └── SettingsView.tsx     # Inställningar
│   ├── hooks/
│   │   ├── useRecorder.ts       # Hook för inspelningsstyrning
│   │   └── usePipeline.ts       # Hook för bearbetningsstatus
│   └── styles/
│       └── globals.css          # Tailwind + glassmorphism
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tauri.conf.json
```

### 3.2 Tauri-konfiguration

```json
// tauri.conf.json — nyckeldelar
{
  "productName": "MötesSkribent",
  "version": "0.1.0",
  "identifier": "se.vasteras.motesskribent",
  "build": {
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "MötesSkribent",
        "width": 800,
        "height": 600,
        "resizable": true,
        "minWidth": 640,
        "minHeight": 480
      }
    ],
    "security": {
      "csp": "default-src 'self'; style-src 'self' 'unsafe-inline'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],
    "resources": ["binaries/*"]
  }
}
```

### 3.3 Python sidecar — bygge och kommunikation

**Bygga sidecar med PyInstaller:**

```bash
# Från Python-projektets rot
pip install pyinstaller

# Skapa standalone-exe
pyinstaller \
    --onedir \
    --name motesskribent-engine \
    --add-data "models/kb-whisper-small-ct2;models/kb-whisper-small-ct2" \
    --hidden-import faster_whisper \
    --hidden-import pyannote.audio \
    --hidden-import onnxruntime \
    src/motesskribent/cli.py

# Output hamnar i dist/motesskribent-engine/
# Kopiera till Tauri-projektets binaries/
```

**Kommunikationsprotokoll (Rust ↔ Python):**

Python-sidecar-processen kommunicerar via JSON över stdin/stdout:

```json
// Rust → Python (request)
{
    "command": "transcribe",
    "params": {
        "audio_path": "C:/Users/erik/recordings/meeting.wav",
        "model_size": "small",
        "num_speakers": null,
        "formats": ["markdown", "json"],
        "vad_enabled": true,
        "initial_prompt": "Västerås stad, vård och omsorg"
    }
}

// Python → Rust (progress updates, en per rad)
{"type": "progress", "stage": "preprocessing", "percent": 5, "message": "Förbehandlar ljud..."}
{"type": "progress", "stage": "diarization", "percent": 35, "message": "Identifierar talare..."}
{"type": "progress", "stage": "transcription", "percent": 80, "message": "Transkriberar (3/5 segment)..."}
{"type": "progress", "stage": "formatting", "percent": 95, "message": "Skapar utfil..."}

// Python → Rust (slutresultat)
{
    "type": "result",
    "success": true,
    "output_files": ["C:/Users/erik/output/meeting_2025-03-12.md", "...json"],
    "summary": {
        "duration": 3600,
        "speakers": 3,
        "processing_time": 240
    }
}

// Python → Rust (fel)
{"type": "error", "message": "Kunde inte ladda modellen", "stage": "transcription"}
```

### 3.4 Ljudfångst i Rust (audio_capture.rs)

```rust
// KRITISK KOMPONENT — Fånga systemljud + mikrofon parallellt
//
// Använd crates:
//   cpal = "0.15"        # Cross-platform audio
//   hound = "3.5"        # WAV-skrivning
//
// WASAPI loopback-inspelning:
// - Kräver Windows
// - cpal stödjer loopback via host-specifika API:er
// - Fångar ALLT systemljud (Teams, Zoom, etc.)
//
// Tvåkanalsinspelning:
// 1. Starta WASAPI loopback-ström (systemljud) → spara till system.wav
// 2. Starta mikrofon-ström (lokal talare) → spara till mic.wav
// 3. Synka med gemensam starttid
// 4. När användaren stoppar: avsluta båda strömmar
// 5. Mergea till en tvåkanalsfil ELLER behåll som separata filer
//
// FALLBACK: Om WASAPI loopback inte fungerar (t.ex. inget ljud spelas),
// falla tillbaka till enbart mikrofon och meddela användaren.
//
// OBS: Loopback kräver att ett ljuduttag är aktivt.
// Om Teams-mötet körs med headset fungerar det.
// Om inget ljud spelas alls ger loopback tystnad.
```

### 3.5 UI-flöde (React)

```
┌─────────────────────────────────────────────┐
│                MötesSkribent                 │
├─────────────────────────────────────────────┤
│                                             │
│  STEG 1: Inspelning                        │
│  ┌───────────────────────────────────────┐  │
│  │                                       │  │
│  │         ● REC  01:23:45               │  │
│  │                                       │  │
│  │     [ Stoppa inspelning ]             │  │
│  │                                       │  │
│  │  🎤 Mikrofon: aktiv                   │  │
│  │  🔊 Systemljud: aktiv                 │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  STEG 2: Bearbetning                       │
│  ┌───────────────────────────────────────┐  │
│  │  ████████████░░░░░ 65%                │  │
│  │  Transkriberar (segment 4 av 12)...   │  │
│  │  Uppskattad tid kvar: ~2 min          │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  STEG 3: Resultat                          │
│  ┌───────────────────────────────────────┐  │
│  │  ✅ Klart! 3 talare identifierade     │  │
│  │  Bearbetningstid: 4 min 12 sek        │  │
│  │                                       │  │
│  │  [Öppna Markdown] [Öppna JSON]        │  │
│  │  [Öppna i mapp]                       │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ⚙ Inställningar                           │
└─────────────────────────────────────────────┘
```

---

## 4. KRITISKA DETALJER OCH FALLGROPAR

### 4.1 Saker som KOMMER gå fel

**pyannote-auth:** pyannote kräver att du accepterar licensvillkor på Hugging Face för varje modell (speaker-diarization-3.1, segmentation-3.0). Du behöver en HF-token. I produktionsbygget måste modellerna vara nedladdade lokalt och token får INTE bäddas in i appen.

**ONNX Runtime-versioner:** pyannote och faster-whisper kan kräva olika versioner av onnxruntime. Lös med:
```bash
pip install onnxruntime==1.17.0  # Testa denna version först
```

**Torch CPU vs GPU:** Om du installerar torch med CUDA-stöd av misstag blir paketet ~2 GB istället för ~200 MB. Se till att använda:
```bash
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
```

**Windows-filsökvägar:** Alla sökvägar bör använda `pathlib.Path` — aldrig strängar med backslash. OneDrive-synkade mappar kan orsaka problem (du har stött på det förut med EAS Build).

**WASAPI loopback:** Fungerar BARA om ett ljuduttag är aktivt på systemet. Om användaren har headset via Bluetooth kan loopback-enheten vara en annan. Appen måste lista tillgängliga enheter och låta användaren välja.

### 4.2 Prestandabudget

Mål: 60 min möte ska bearbetas på **under 8 minuter** på standardlaptop.

| Steg | Utan optimering | Med optimering | Metod |
|------|----------------|----------------|-------|
| VAD-filtrering | 30 sek | 30 sek | Silero VAD |
| Talarseparering | 4-6 min | 2-3 min | ONNX Runtime |
| Transkribering | 15-20 min | 3-6 min | small + INT8 + VAD |
| Formatering | 5 sek | 5 sek | — |
| **Totalt** | **~25 min** | **~6 min** | |

Nyckeln: **small-modellen + VAD-filtrering + INT8-kvantisering** ger den överlägset bästa speedupen utan extra komplexitet.

### 4.3 GDPR-checklista

- [ ] All bearbetning sker lokalt — verifierat med nätverksmonitor
- [ ] Ingen telemetri, inga analytics, inga hemtelefoneringar
- [ ] Ljudfiler kan raderas automatiskt efter transkribering
- [ ] Output-filer sparas på användarens valda plats
- [ ] Intern DPIA genomförd
- [ ] Informationsklassning av inspelat material bestämd
- [ ] Samtyckesrutin: appen visar påminnelse att informera mötesdeltagare
- [ ] HF-token lagras säkert (Windows Credential Manager, inte plaintext)

### 4.4 Framtida optimeringar (utanför pilot)

1. **OpenVINO-backend** för Intel-CPUs (~30-50% speedup)
2. **Parallell chunk-bearbetning** på flera CPU-kärnor
3. **Lokal GPU-server** på kommunens nät för realtid
4. **Nära-realtid med streaming** om efterbearbetning inte räcker
5. **Talaridentifiering** (inte bara separering) — koppla ihop röster med namn baserat på röstprofiler
6. **DOCX-export** med Västerås stads mötesmall
7. **Integration med ärendehanteringssystem**

---

## 5. BYGGORDNING FÖR CLAUDE CODE

Bygg i exakt denna ordning. Varje steg ska fungera och testas innan nästa påbörjas.

### Sprint 1: Grundläggande pipeline
1. Sätt upp projektstruktur och beroenden
2. Implementera `transcriber.py` — testa med en WAV-fil, ingen diarisering
3. Implementera `diarizer.py` — testa isolerat med samma WAV-fil
4. Implementera `preprocessor.py` med VAD-filtrering
5. Implementera `formatter.py` — markdown och JSON-output
6. Koppla ihop i `pipeline.py` med talarmappning
7. Bygga `cli.py` med Rich progress

### Sprint 2: Kvalitetstestning
8. Testa med 3-5 olika mötesinspelningar
9. Tuning av parametrar (VAD-tröskel, merge-gap, beam size)
10. Prestandamätning — verifiera < 8 min för 60 min möte
11. Testa med small vs medium för kvalitetsjämförelse

### Sprint 3: Desktop-app (Fas 2)
12. Sätt upp Tauri-projekt med React + Vite
13. Implementera UI (RecordingView, ProcessingView, ResultView)
14. Implementera sidecar-kommunikation
15. Implementera ljudfångst (mikrofon först, WASAPI loopback sedan)
16. Bygga PyInstaller-exe av Python-pipelinen
17. Integrera sidecar i Tauri-build
18. Testa installer och distribution

---

## 6. KOMMANDON FÖR SNABBSTART

```bash
# Skapa projekt
mkdir motesskribent && cd motesskribent
python -m venv .venv
.venv\Scripts\activate

# Installera beroenden
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
pip install faster-whisper pyannote.audio soundfile click rich

# Logga in på Hugging Face (för pyannote-modeller)
pip install huggingface-hub
huggingface-cli login

# Konvertera KB-modell
pip install ctranslate2
ct2-transformers-converter --model KBLab/kb-whisper-small --output_dir models/kb-whisper-small-ct2 --quantization int8 --copy_files tokenizer.json preprocessor_config.json

# Kör första testet (efter implementation)
python -m motesskribent.cli transkribera test.wav --modell small
```
