import { useRecorder } from "../hooks/useRecorder";
import { useAudioDevices } from "../hooks/useAudioDevices";
import { useAudioLevel } from "../hooks/useAudioLevel";
import AudioLevelBars from "./AudioLevelBars";
import type { PipelineSettings } from "../hooks/usePipeline";

interface Props {
  onRecordingComplete: (filePath: string, settings: PipelineSettings, deviceName: string) => void;
  settings: PipelineSettings;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function RecordingView({ onRecordingComplete, settings }: Props) {
  const recorder = useRecorder();
  const audioDevices = useAudioDevices();
  const levels = useAudioLevel(recorder.status === "recording");

  const handleStart = async () => {
    await recorder.start(audioDevices.selectedDeviceId);
  };

  const handleStop = async () => {
    const result = await recorder.stop();
    if (result) {
      onRecordingComplete(result.path, settings, result.device_name);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-6 animate-fade-in">
      {/* Microphone icon */}
      <div
        className={`w-20 h-20 mx-auto rounded-full flex items-center justify-center glass transition-all ${
          recorder.status === "recording"
            ? "border-[var(--color-error)]"
            : ""
        }`}
        style={
          recorder.status === "recording"
            ? { boxShadow: "0 0 24px rgba(239, 68, 68, 0.3)" }
            : {}
        }
      >
        <svg
          className={`w-10 h-10 ${
            recorder.status === "recording"
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

      {recorder.status === "recording" ? (
        <>
          {/* REC indicator + timer */}
          <div className="space-y-2">
            <div className="flex items-center justify-center gap-2">
              <span className="animate-pulse-rec w-3 h-3 rounded-full bg-[var(--color-error)] inline-block" />
              <span className="text-sm font-medium text-[var(--color-error)] uppercase tracking-wider">
                REC
              </span>
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

          {/* Stop button */}
          <button
            onClick={handleStop}
            disabled={recorder.status !== "recording"}
            className="px-6 py-3 rounded-lg bg-[var(--color-error)] hover:bg-[var(--color-error)]/80 text-white font-medium text-sm transition-all"
            style={{ boxShadow: "0 0 20px rgba(239, 68, 68, 0.25)" }}
          >
            Stoppa inspelning
          </button>
        </>
      ) : (
        <>
          {/* Title */}
          <h2 className="text-xl font-semibold">Inspelning</h2>

          {/* Device selector */}
          <div className="text-left space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm text-[var(--color-text-muted)]">Ljudkälla</label>
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
            <select
              value={audioDevices.selectedDeviceId}
              onChange={(e) => audioDevices.selectDevice(e.target.value)}
              className="w-full px-3 py-2 rounded-lg glass text-sm bg-transparent border border-white/10 focus:border-[var(--color-primary)] focus:outline-none transition-colors"
            >
              {audioDevices.devices.map((dev) => (
                <option key={dev.id} value={dev.id}>
                  {dev.name}
                </option>
              ))}
            </select>
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
