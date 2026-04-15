import { useState, useRef, useEffect } from "react";
import type { Recorder } from "../hooks/useRecorder";
import { useAudioDevices } from "../hooks/useAudioDevices";
import AudioLevelBars from "./AudioLevelBars";
import type { PipelineSettings } from "../hooks/usePipeline";

interface Props {
  onRecordingComplete: (filePath: string, settings: PipelineSettings, deviceName: string) => void;
  settings: PipelineSettings;
  recorder: Recorder;
  audioLevels: number[];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const CATEGORIES: Record<string, string> = {
  input: "Mikrofoner",
  loopback: "Systemljud (loopback)",
  mixed: "Mikrofon + Systemljud",
};

function DeviceDropdown({
  devices,
  selectedId,
  onSelect,
}: {
  devices: { id: string; name: string; category: string }[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = devices.find((d) => d.id === selectedId);
  const grouped = new Map<string, typeof devices>();
  for (const dev of devices) {
    const cat = dev.category || "input";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(dev);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full px-3 py-2 rounded-lg text-sm bg-[var(--color-surface)] border border-white/10 focus:border-[var(--color-primary)] focus:outline-none transition-colors text-left flex items-center justify-between"
      >
        <span className={selected ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}>
          {selected?.name || "Välj enhet..."}
        </span>
        <svg
          className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg bg-[var(--color-surface)] border border-white/10 shadow-lg max-h-60 overflow-y-auto">
          {Array.from(grouped.entries()).map(([cat, devs]) => (
            <div key={cat}>
              <div className="px-3 py-1.5 text-xs text-[var(--color-text-muted)] font-medium">
                {CATEGORIES[cat] || cat}
              </div>
              {devs.map((dev) => (
                <button
                  key={dev.id}
                  type="button"
                  onClick={() => {
                    onSelect(dev.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                    dev.id === selectedId
                      ? "bg-[var(--color-primary)] text-white"
                      : "text-[var(--color-text)] hover:bg-white/5"
                  }`}
                >
                  {dev.name}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RecordingView({ onRecordingComplete, settings, recorder, audioLevels: levels }: Props) {
  const audioDevices = useAudioDevices();
  const [showInfo, setShowInfo] = useState(false);

  const isActive = recorder.status === "recording" || recorder.status === "paused";
  const isPaused = recorder.status === "paused";

  const handleStart = async () => {
    await recorder.start(audioDevices.selectedDeviceId);
  };

  const handleStop = async () => {
    const result = await recorder.stop();
    if (result) {
      onRecordingComplete(result.path, settings, result.device_name);
    }
  };

  const handlePauseResume = async () => {
    if (isPaused) {
      await recorder.resume();
    } else {
      await recorder.pause();
    }
  };

  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-6 animate-fade-in">
      {/* Microphone icon */}
      <div
        className={`w-20 h-20 mx-auto rounded-full flex items-center justify-center glass transition-all ${
          isPaused
            ? "border-yellow-400"
            : isActive
              ? "border-[var(--color-error)]"
              : ""
        }`}
        style={
          isPaused
            ? { boxShadow: "0 0 24px rgba(234, 179, 8, 0.3)" }
            : isActive
              ? { boxShadow: "0 0 24px rgba(239, 68, 68, 0.3)" }
              : {}
        }
      >
        <svg
          className={`w-10 h-10 ${
            isPaused
              ? "text-yellow-400"
              : isActive
                ? "text-[var(--color-error)]"
                : "text-[var(--color-text-muted)]"
          }`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
          />
        </svg>
      </div>

      {isActive ? (
        <>
          {/* REC / PAUSAD indicator + timer */}
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2">
              {isPaused ? (
                <>
                  <span className="w-3 h-3 rounded-full bg-yellow-400 inline-block" />
                  <span className="text-sm font-medium text-yellow-400 uppercase tracking-wider">
                    Pausad
                  </span>
                </>
              ) : (
                <>
                  <span className="animate-pulse-rec w-3 h-3 rounded-full bg-[var(--color-error)] inline-block" />
                  <span className="text-sm font-medium text-[var(--color-error)] uppercase tracking-wider">
                    REC
                  </span>
                </>
              )}
            </div>
            <p className="text-4xl font-mono font-semibold tabular-nums">
              {formatTime(recorder.elapsedSeconds)}
            </p>
            <AudioLevelBars levels={levels} />
            {recorder.deviceName && (
              <p className="text-xs text-[var(--color-text-muted)]">
                {recorder.deviceName}
              </p>
            )}
          </div>

          {/* Pause/Resume + Stop buttons */}
          <div className="flex items-center justify-center gap-3">
            <button
              onClick={handlePauseResume}
              className={`px-5 py-3 rounded-lg font-medium text-sm transition-all ${
                isPaused
                  ? "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
                  : "glass text-[var(--color-text)] hover:bg-white/10"
              }`}
              style={isPaused ? { boxShadow: "0 0 20px rgba(37, 99, 235, 0.25)" } : {}}
            >
              {isPaused ? "Återuppta" : "Pausa"}
            </button>
            <button
              onClick={handleStop}
              className="px-5 py-3 rounded-lg bg-[var(--color-error)] hover:bg-[var(--color-error)]/80 text-white font-medium text-sm transition-all"
              style={{ boxShadow: "0 0 20px rgba(239, 68, 68, 0.25)" }}
            >
              Stoppa
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Title */}
          <h2 className="text-xl font-semibold">Inspelning</h2>

          {/* Device selector */}
          <div className="text-left space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <label className="text-sm text-[var(--color-text-muted)]">Ljudkälla</label>
                <button
                  onClick={() => setShowInfo(!showInfo)}
                  className={`w-4 h-4 rounded-full text-[10px] font-bold leading-none flex items-center justify-center transition-colors ${
                    showInfo
                      ? "bg-[var(--color-primary)] text-white"
                      : "bg-white/10 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/20"
                  }`}
                  title="Visa information om ljudkällor"
                >
                  i
                </button>
              </div>
              <button
                onClick={audioDevices.refresh}
                disabled={audioDevices.loading}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors p-1"
                title="Uppdatera enhetslistan"
              >
                <svg className={`w-3.5 h-3.5 ${audioDevices.loading ? "animate-spin" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>
            {showInfo && (
              <div className="glass rounded-lg px-3 py-2.5 text-xs space-y-1.5" style={{ borderColor: "rgba(255,255,255,0.1)" }}>
                <p><span className="font-medium text-[var(--color-text)]">Mikrofoner</span> <span className="text-[var(--color-text-muted)]">— Spelar in ljud från en mikrofon (din röst). Välj denna om du bara vill fånga vad som sägs i rummet.</span></p>
                <p><span className="font-medium text-[var(--color-text)]">Systemljud</span> <span className="text-[var(--color-text-muted)]">— Spelar in ljud som spelas upp av datorn (t.ex. motpartens röst i ett videosamtal). Ingen mikrofon används.</span></p>
                <p><span className="font-medium text-[var(--color-text)]">Mikrofon + Systemljud</span> <span className="text-[var(--color-text-muted)]">— Kombinerar mikrofon och systemljud i en inspelning. Bäst för videosamtal där du vill fånga både din röst och motpartens. Talare separeras automatiskt baserat på kanal.</span></p>
              </div>
            )}
            <DeviceDropdown
              devices={audioDevices.devices}
              selectedId={audioDevices.selectedDeviceId}
              onSelect={audioDevices.selectDevice}
            />
            {audioDevices.error && (
              <p className="text-xs text-[var(--color-error)]">{audioDevices.error}</p>
            )}
          </div>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={recorder.status === "stopping"}
            className={`px-6 py-3 rounded-lg font-medium text-sm transition-all ${
              recorder.status === "stopping"
                ? "glass text-[var(--color-text-muted)] cursor-not-allowed"
                : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white hover:shadow-[0_0_20px_rgba(37,99,235,0.25)]"
            }`}
          >
            {recorder.status === "stopping" ? "Stoppar..." : "Starta inspelning"}
          </button>
        </>
      )}

      {/* Warning message */}
      {recorder.warning && (
        <p className="text-sm text-yellow-400 glass rounded-xl px-4 py-2" style={{ borderColor: "rgba(234, 179, 8, 0.3)" }}>
          {recorder.warning}
        </p>
      )}

      {/* Error message */}
      {recorder.error && (
        <p className="text-sm text-[var(--color-error)] glass rounded-xl px-4 py-2" style={{ borderColor: "rgba(239, 68, 68, 0.3)" }}>
          {recorder.error}
        </p>
      )}
    </div>
  );
}
