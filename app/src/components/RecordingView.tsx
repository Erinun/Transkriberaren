import { useState, useEffect } from "react";
import type { Recorder } from "../hooks/useRecorder";
import { useAudioMode } from "../hooks/useAudioMode";
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

function HeadphonesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M12 3a9 9 0 00-9 9v2a3 3 0 003 3h1a1 1 0 001-1v-4a1 1 0 00-1-1H5v-1a7 7 0 0114 0v1h-2a1 1 0 00-1 1v4a1 1 0 001 1h1a3 3 0 003-3v-2a9 9 0 00-9-9z"
      />
    </svg>
  );
}

function SpeakersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
      />
    </svg>
  );
}

function ChevronIcon({ className, expanded }: { className?: string; expanded: boolean }) {
  return (
    <svg
      className={`${className} transition-transform ${expanded ? "rotate-90" : ""}`}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

function deviceLabel(device: { name: string; is_console_default: boolean; is_communications_default: boolean }): string {
  const tags: string[] = [];
  if (device.is_console_default) tags.push("standard");
  if (device.is_communications_default) tags.push("kommunikation");
  return tags.length > 0 ? `${device.name} (${tags.join(", ")})` : device.name;
}

export default function RecordingView({ onRecordingComplete, settings, recorder, audioLevels: levels }: Props) {
  const audioMode = useAudioMode();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isActive = recorder.status === "recording" || recorder.status === "paused";
  const isPaused = recorder.status === "paused";

  // Stop polling during recording, resume when stopped
  useEffect(() => {
    if (isActive) {
      audioMode.stopPolling();
    } else {
      audioMode.startPolling();
    }
  }, [isActive]);

  const handleStart = async () => {
    const override = audioMode.manualOutputDevice ?? undefined;
    await recorder.start(audioMode.activeMode, override);
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

  const canStart = audioMode.hasMicrophone && recorder.status !== "stopping";

  // The effective output device name to display
  const displayOutputDevice = audioMode.manualOutputDevice || audioMode.outputDeviceName || "Standard";

  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-6 animate-fade-in">
      {/* Mode icon */}
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
        {audioMode.activeMode === "headphones" ? (
          <HeadphonesIcon
            className={`w-10 h-10 ${
              isPaused
                ? "text-yellow-400"
                : isActive
                  ? "text-[var(--color-error)]"
                  : "text-[var(--color-text-muted)]"
            }`}
          />
        ) : (
          <SpeakersIcon
            className={`w-10 h-10 ${
              isPaused
                ? "text-yellow-400"
                : isActive
                  ? "text-[var(--color-error)]"
                  : "text-[var(--color-text-muted)]"
            }`}
          />
        )}
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

          {/* Mode toggle */}
          <div className="space-y-3">
            <div className="inline-flex rounded-lg overflow-hidden border border-white/10">
              <button
                onClick={() => audioMode.activeMode !== "headphones" && audioMode.toggleMode()}
                className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${
                  audioMode.activeMode === "headphones"
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5"
                }`}
              >
                <HeadphonesIcon className="w-4 h-4" />
                <span>Hörlurar</span>
                {audioMode.detectedMode === "headphones" && !audioMode.isOverridden && (
                  <span className="text-[10px] opacity-70 uppercase tracking-wider">auto</span>
                )}
              </button>
              <button
                onClick={() => audioMode.activeMode !== "speakers" && audioMode.toggleMode()}
                className={`px-4 py-2 text-sm font-medium transition-colors flex items-center gap-2 ${
                  audioMode.activeMode === "speakers"
                    ? "bg-[var(--color-primary)] text-white"
                    : "bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5"
                }`}
              >
                <SpeakersIcon className="w-4 h-4" />
                <span>Högtalare</span>
                {audioMode.detectedMode === "speakers" && !audioMode.isOverridden && (
                  <span className="text-[10px] opacity-70 uppercase tracking-wider">auto</span>
                )}
              </button>
            </div>

            {/* Device info */}
            <div className="space-y-0.5 text-xs text-[var(--color-text-muted)]">
              {audioMode.hasMicrophone ? (
                <p>Mikrofon: {audioMode.microphoneName || "Standard"}</p>
              ) : (
                <p className="text-[var(--color-error)]">Ingen mikrofon ansluten</p>
              )}
              <p>Ljud: {displayOutputDevice}</p>
            </div>

            {/* Fallback warning */}
            {audioMode.usedFallback && !audioMode.manualOutputDevice && (
              <p className="text-xs text-yellow-400 glass rounded-lg px-3 py-2 text-left" style={{ borderColor: "rgba(234, 179, 8, 0.3)" }}>
                Kunde inte hitta kommunikationsenhet — använder standardutgång. Kontrollera att rätt enhet är vald i Windows ljudinställningar.
              </p>
            )}

            {audioMode.error && (
              <p className="text-xs text-[var(--color-error)]">{audioMode.error}</p>
            )}

            {/* Advanced section — output device override */}
            <div className="text-left">
              <button
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors flex items-center gap-1"
              >
                <ChevronIcon className="w-3 h-3" expanded={advancedOpen} />
                <span>Avancerat</span>
              </button>

              {advancedOpen && (
                <div className="mt-2 space-y-1.5">
                  <label className="text-xs text-[var(--color-text-muted)] block">
                    Utgångsenhet för loopback
                  </label>
                  <select
                    value={audioMode.manualOutputDevice ?? ""}
                    onChange={(e) => {
                      const val = e.target.value;
                      audioMode.setManualOutputDevice(val === "" ? null : val);
                    }}
                    className="w-full text-xs rounded-lg px-3 py-2 bg-[var(--color-surface)] text-[var(--color-text)] border border-white/10 focus:outline-none focus:border-[var(--color-primary)]"
                  >
                    <option value="">Automatiskt</option>
                    {audioMode.outputDevices.map((device) => (
                      <option key={device.name} value={device.name}>
                        {deviceLabel(device)}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          {/* Start button */}
          <button
            onClick={handleStart}
            disabled={!canStart}
            className={`px-6 py-3 rounded-lg font-medium text-sm transition-all ${
              !canStart
                ? "glass text-[var(--color-text-muted)] cursor-not-allowed"
                : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white hover:shadow-[0_0_20px_rgba(37,99,235,0.25)]"
            }`}
            title={!audioMode.hasMicrophone ? "Anslut en mikrofon för att spela in" : undefined}
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
