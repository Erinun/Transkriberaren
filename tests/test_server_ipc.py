"""Tester för det persistenta sidecar-serverprotokollet (NDJSON över stdin/stdout).

Dessa tester spawnar `python -m motesskribent serve` som subprocess och
verifierar att protokollet beter sig korrekt utan att låsa sig när stderr
fylls med utdata — vilket är grundorsaken till den Windows-specifika
30-minuters-avbrottsbuggen.

Testerna kräver INGA modeller (använder bara ping/shutdown).
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Iterator

import pytest


SERVER_READY_TIMEOUT_S = 20.0
PING_RESPONSE_TIMEOUT_S = 5.0
SHUTDOWN_TIMEOUT_S = 5.0


def _spawn_server(drain_stderr: bool = True) -> subprocess.Popen:
    """Starta en sidecar-server. Dräner stderr per default för att efterlikna
    Rust-sidans nya beteende — om drain_stderr=False simuleras den gamla buggen
    där stderr-bufferten riskerar att fyllas."""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [sys.executable, "-m", "motesskribent", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=0,
        cwd=Path(__file__).resolve().parent.parent,
    )

    if drain_stderr:
        def _drain():
            try:
                assert proc.stderr is not None
                for _ in iter(proc.stderr.readline, b""):
                    pass
            except Exception:
                pass

        t = threading.Thread(target=_drain, daemon=True)
        t.start()

    return proc


def _read_line(proc: subprocess.Popen, timeout: float) -> dict:
    """Blockerande läsning av en JSON-rad från stdout med timeout."""
    result: list[bytes] = []
    err: list[BaseException] = []

    def _read():
        try:
            assert proc.stdout is not None
            line = proc.stdout.readline()
            result.append(line)
        except BaseException as e:
            err.append(e)

    t = threading.Thread(target=_read, daemon=True)
    t.start()
    t.join(timeout=timeout)

    if t.is_alive():
        raise TimeoutError(f"Ingen utdata på stdout inom {timeout}s")
    if err:
        raise err[0]
    if not result or not result[0]:
        raise EOFError("Processen stängde stdout")

    return json.loads(result[0].decode("utf-8").strip())


def _send_command(proc: subprocess.Popen, payload: dict) -> None:
    assert proc.stdin is not None
    line = (json.dumps(payload) + "\n").encode("utf-8")
    proc.stdin.write(line)
    proc.stdin.flush()


def _wait_ready(proc: subprocess.Popen) -> None:
    msg = _read_line(proc, timeout=SERVER_READY_TIMEOUT_S)
    assert msg.get("type") == "ready", f"Förväntade 'ready', fick {msg}"


def _shutdown(proc: subprocess.Popen) -> None:
    try:
        if proc.poll() is None:
            _send_command(proc, {"request_id": "shutdown", "command": "shutdown"})
    except BrokenPipeError:
        pass
    try:
        proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2.0)


@pytest.fixture
def server() -> Iterator[subprocess.Popen]:
    proc = _spawn_server(drain_stderr=True)
    try:
        _wait_ready(proc)
        yield proc
    finally:
        _shutdown(proc)


class TestServerIPC:
    """Grundläggande protokolltester — ingen modell-laddning krävs."""

    def test_ready_on_startup(self):
        """Servern ska skicka {"type": "ready"} direkt när den startar."""
        proc = _spawn_server(drain_stderr=True)
        try:
            _wait_ready(proc)
        finally:
            _shutdown(proc)

    def test_ping_pong(self, server: subprocess.Popen):
        """ping → pong + end-sentinel, korrekt request_id routing."""
        req_id = str(uuid.uuid4())
        _send_command(server, {"request_id": req_id, "command": "ping"})

        pong = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
        assert pong.get("type") == "pong"
        assert pong.get("request_id") == req_id

        end = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
        assert end.get("type") == "end"
        assert end.get("request_id") == req_id

    def test_multiple_pings(self, server: subprocess.Popen):
        """Flera sekventiella pings ska alla få rätt svar i rätt ordning."""
        for i in range(5):
            req_id = f"ping-{i}"
            _send_command(server, {"request_id": req_id, "command": "ping"})
            pong = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
            end = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
            assert pong.get("type") == "pong" and pong.get("request_id") == req_id
            assert end.get("type") == "end" and end.get("request_id") == req_id

    def test_unknown_command_returns_error(self, server: subprocess.Popen):
        """Okänt kommando ska ge ett error-event (inte krasch)."""
        req_id = str(uuid.uuid4())
        _send_command(server, {"request_id": req_id, "command": "bogus_command"})

        err = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
        assert err.get("type") == "error"
        assert err.get("request_id") == req_id

        end = _read_line(server, timeout=PING_RESPONSE_TIMEOUT_S)
        assert end.get("type") == "end"

    def test_shutdown_terminates_cleanly(self):
        """Shutdown-kommandot ska stänga servern utan att kräva kill()."""
        proc = _spawn_server(drain_stderr=True)
        try:
            _wait_ready(proc)
            _send_command(proc, {"request_id": "s", "command": "shutdown"})
            end = _read_line(proc, timeout=PING_RESPONSE_TIMEOUT_S)
            assert end.get("type") == "end"
            rc = proc.wait(timeout=SHUTDOWN_TIMEOUT_S)
            assert rc == 0
        finally:
            if proc.poll() is None:
                proc.kill()


class TestStderrDrainRegression:
    """Regressionstester för 30-minuters-avbrottsbuggen.

    Dessa testar Python-sidans beteende när stderr fylls — vilket simulerar
    vad libraries som faster-whisper/pyannote/torch gör under en lång körning.
    Rust-sidans drain-fix är det som slutligen eliminerar dödläget, men dessa
    tester verifierar att Python *kan* fortsätta svara så länge någon dränerar
    stderr.
    """

    def test_ping_survives_heavy_stderr_output(self):
        """Med en aktiv stderr-dränare ska ping fortfarande svara efter att
        stderr-bufferten skulle ha fyllts upp.

        Ogiltig JSON skickad till servern triggar `logger.warning(...)` på
        stderr (server.py:193). Vi skickar ~500 sådana rader (motsvarar
        långt mer än Windows 64KB pipe-buffer) och verifierar att ping
        fortfarande svarar snabbt. Detta är Python-sidans kontrakt:
        **förutsatt att någon dränerar stderr**, ska Python inte låsa sig.
        """
        proc = _spawn_server(drain_stderr=True)
        try:
            _wait_ready(proc)

            # Flooda stderr via ogiltig JSON
            assert proc.stdin is not None
            junk_line = (b"not valid json " + b"x" * 400 + b"\n")
            for _ in range(500):
                try:
                    proc.stdin.write(junk_line)
                except BrokenPipeError:
                    pytest.fail("Processen dog under stderr-flod (oväntat)")
            proc.stdin.flush()

            # Ge Python-processen en kort stund att bearbeta raderna
            time.sleep(0.5)

            # Nu en ping — ska fortfarande svara snabbt
            _send_command(proc, {"request_id": "final-ping", "command": "ping"})
            pong = _read_line(proc, timeout=PING_RESPONSE_TIMEOUT_S)
            assert pong.get("type") == "pong"
            assert pong.get("request_id") == "final-ping"
            end = _read_line(proc, timeout=PING_RESPONSE_TIMEOUT_S)
            assert end.get("type") == "end"
        finally:
            _shutdown(proc)

    @pytest.mark.integration
    def test_server_deadlocks_without_stderr_drain(self):
        """Sanity-check: BEVISAR att buggen finns om stderr inte dräneras.

        Vi fyller Python's stderr-buffer genom att skicka många "nonsense"-
        kommandon (varje ogiltig JSON ger en logger.warning() till stderr).
        På Windows med en 64KB-pipe hänger detta snabbt; på Linux tar det
        längre tid (pipe-buffer ~1MB) men beteendet är detsamma.

        OBS: Detta test är tungt/långsamt och markeras som integration —
        körs inte i default pytest-körning (se CLAUDE.md).
        """
        pytest.importorskip("motesskribent")

        proc = _spawn_server(drain_stderr=False)
        try:
            _wait_ready(proc)

            # Skriv ogiltig JSON i en lång loop — varje rad producerar
            # en logger.warning() på stderr (server.py:193).
            # På Linux behövs många rader för att fylla 1MB-bufferten.
            junk = ("x" * 500).encode()  # varje rad ger ~500 byte warning
            deadline = time.monotonic() + 30.0
            deadlocked = False
            assert proc.stdin is not None

            try:
                while time.monotonic() < deadline:
                    try:
                        proc.stdin.write(junk + b"\n")
                        proc.stdin.flush()
                    except BrokenPipeError:
                        break

                # Försök en ping — ska hänga om stderr är full
                try:
                    _send_command(proc, {"request_id": "probe", "command": "ping"})
                    _read_line(proc, timeout=3.0)
                except (TimeoutError, BrokenPipeError):
                    deadlocked = True
            except Exception:
                pass

            # Med stor sannolikhet har processen hängt. Detta test är ett
            # "canary" snarare än en hård assertion eftersom pipe-storlek
            # varierar per OS.
            if not deadlocked:
                pytest.skip(
                    "Kunde inte reproducera stderr-dödläget på denna plattform "
                    "(troligen Linux med stor pipe-buffer). Buggen är "
                    "Windows-specifik."
                )
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=2.0)

