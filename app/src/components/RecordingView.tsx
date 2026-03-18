import { useRecorder } from "../hooks/useRecorder";
import { useAudioLevel } from "../hooks/useAudioLevel";
import AudioLevelBars from "./AudioLevelBars";
import type { PipelineSettings } from "../hooks/usePipeline";

interface Props {
  onRecordingComplete: (filePath: string, settings: PipelineSettings) => void;
  settings: PipelineSettings;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function RecordingView({ onRecordingComplete, settings }: Props) {
  const recorder = useRecorder();
  const levels = useAudioLevel(recorder.status === "recording");

  const handleStart = async () => {
    await recorder.start();
  };

  const handleStop = async () => {
    const filePath = await recorder.stop();
    if (filePath) {
      onRecordingComplete(filePath, settings);
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

      {/* Error message */}
      {recorder.error && (
        <p className="text-sm text-[var(--color-error)] glass rounded-xl px-4 py-2" style={{ borderColor: "rgba(239, 68, 68, 0.3)" }}>
          {recorder.error}
        </p>
      )}
    </div>
  );
}
