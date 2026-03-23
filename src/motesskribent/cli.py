"""CLI-interface för MötesSkribent."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
from rich.table import Table

from motesskribent import __version__

console = Console()

KNOWN_MODELS = [
    ("KBLab/kb-whisper-tiny", "tiny", "~160 MB", "Snabbast, bra kvalitet"),
    ("KBLab/kb-whisper-base", "base", "~240 MB", "Snabb, mycket bra kvalitet (rekommenderas)"),
    ("KBLab/kb-whisper-small", "small", "~460 MB", "Bra balans hastighet/kvalitet"),
    ("KBLab/kb-whisper-medium", "medium", "~1.5 GB", "Bättre kvalitet, långsammare"),
    ("KBLab/kb-whisper-large", "large", "~3 GB", "Bästa kvalitet, kräver mer minne"),
]


@click.group()
@click.option("--debug", is_flag=True, help="Aktivera debug-loggning.")
@click.version_option(version=__version__, prog_name="MötesSkribent")
def main(debug: bool):
    """MötesSkribent — Lokal mötesanteckning med AI."""
    level = logging.DEBUG if debug else logging.WARNING
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def _emit_json(data: dict):
    """Skriv en JSON-rad till stdout för IPC."""
    import json
    print(json.dumps(data, ensure_ascii=False), flush=True)


def _run_json_ipc(audio_file: Path, config):
    """Kör pipeline med JSON-IPC output istället för Rich."""
    from motesskribent.pipeline import run_pipeline

    steps_sv = {
        "preprocessing": "Förbehandlar ljud",
        "diarization": "Identifierar talare",
        "transcription": "Transkriberar",
        "formatting": "Formaterar output",
    }

    def on_progress(step: str, fraction: float):
        _emit_json({
            "type": "progress",
            "stage": step,
            "percent": round(fraction * 100),
            "message": steps_sv.get(step, step),
        })

    try:
        result = run_pipeline(audio_file, config, progress_callback=on_progress)
        _emit_json({
            "type": "result",
            "success": True,
            "output_files": [str(f) for f in result.output_files],
            "md_content": result.md_content,
            "warnings": result.warnings,
            "model_name": str(config.model_path),
            "word_count": sum(len(seg.text.split()) for seg in result.segments),
            "segments": [
                {
                    "start": seg.start,
                    "end": seg.end,
                    "speaker_id": seg.speaker_id,
                    "speaker_label": seg.speaker_label,
                    "text": seg.text,
                }
                for seg in result.segments
            ],
            "summary": {
                "total_duration": result.total_duration,
                "speech_duration": result.speech_duration,
                "processing_time": result.processing_time,
                "num_speakers": result.num_speakers,
                "num_segments": len(result.segments),
            },
        })
    except Exception as e:
        _emit_json({
            "type": "error",
            "message": str(e),
            "stage": "pipeline",
        })
        sys.exit(1)


@main.command()
@click.argument("audio_file", type=click.Path(exists=True, path_type=Path))
@click.option("--modell", default="KBLab/kb-whisper-base", help="Whisper-modell att använda.")
@click.option("--talare", type=int, default=None, help="Antal talare (auto om ej angivet).")
@click.option("--format", "formats", multiple=True, default=["markdown", "json"],
              help="Outputformat (markdown, json).")
@click.option("--output", type=click.Path(path_type=Path), default=Path("output"),
              help="Katalog för utdata.")
@click.option("--prompt", type=str, default=None,
              help="Domänspecifika termer för bättre transkribering.")
@click.option("--no-vad", is_flag=True, help="Inaktivera VAD-filtrering.")
@click.option("--speed-profile", type=click.Choice(["fast", "balanced", "quality"]),
              default="balanced", help="Hastighetsprofil (default: balanced).")
@click.option("--json-ipc", is_flag=True, help="JSON-output för IPC (används av GUI).")
def transkribera(audio_file: Path, modell: str, talare: int | None,
                 formats: tuple[str, ...], output: Path, prompt: str | None,
                 no_vad: bool, speed_profile: str, json_ipc: bool):
    """Transkribera en ljudfil med talarseparering."""
    from motesskribent.pipeline import PipelineConfig, run_pipeline

    config = PipelineConfig(
        model_path=modell,
        num_speakers=talare,
        output_dir=output,
        output_formats=list(formats),
        initial_prompt=prompt,
        vad_enabled=not no_vad,
        speed_profile=speed_profile,
    )

    if json_ipc:
        _run_json_ipc(audio_file, config)
        return

    steps = {
        "preprocessing": "Förbehandlar ljud...",
        "diarization": "Identifierar talare...",
        "transcription": "Transkriberar...",
        "formatting": "Formaterar output...",
    }

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Startar...", total=100)

        def on_progress(step: str, fraction: float):
            desc = steps.get(step, step)
            progress.update(task, completed=fraction * 100, description=desc)

        try:
            result = run_pipeline(audio_file, config, progress_callback=on_progress)
        except Exception as e:
            console.print(f"\n[red bold]Fel:[/red bold] {e}")
            sys.exit(1)

    console.print()
    console.print("[green bold]Transkribering klar![/green bold]")
    console.print(f"  Längd: {result.total_duration:.0f}s ljud → {result.processing_time:.1f}s bearbetning")
    console.print(f"  Talare: {result.num_speakers}")
    console.print(f"  Segment: {len(result.segments)}")
    console.print()
    for f in result.output_files:
        console.print(f"  [blue]{f}[/blue]")


@main.command()
def modeller():
    """Visa tillgängliga KB-Whisper-modeller."""
    table = Table(title="KB-Whisper-modeller")
    table.add_column("Modell", style="cyan")
    table.add_column("Storlek", style="green")
    table.add_column("RAM", style="yellow")
    table.add_column("Beskrivning")

    for model_id, size, ram, desc in KNOWN_MODELS:
        table.add_row(model_id, size, ram, desc)

    console.print(table)


@main.command()
def serve():
    """Persistent sidecar-server för GUI (intern)."""
    from motesskribent.server import run_server
    run_server()


@main.command()
def info():
    """Visa systeminformation och uppskattningar."""
    import platform

    cpu_count = os.cpu_count() or 0

    table = Table(title="Systeminformation")
    table.add_column("Egenskap", style="cyan")
    table.add_column("Värde", style="green")

    table.add_row("OS", platform.platform())
    table.add_row("Python", platform.python_version())
    table.add_row("CPU-kärnor", str(cpu_count))
    table.add_row("Trådar (whisper)", str(max(1, cpu_count // 2)))
    table.add_row("MötesSkribent", __version__)

    try:
        import psutil
        mem = psutil.virtual_memory()
        table.add_row("RAM", f"{mem.total / (1024**3):.1f} GB")
        table.add_row("RAM tillgängligt", f"{mem.available / (1024**3):.1f} GB")
    except ImportError:
        table.add_row("RAM", "(installera psutil för detaljer)")

    console.print(table)
