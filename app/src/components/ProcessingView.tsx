import { useState, useEffect } from "react";
import type { EventLogEntry } from "../hooks/usePipeline";

interface Props {
  stage: string;
  percent: number;
  message: string;
  isIndeterminate?: boolean;
  lastEventTime: number;
  startTime: number;
  eventLog: EventLogEntry[];
}

const STAGE_LABELS: Record<string, string> = {
  preprocessing: "Forbehandlar ljud",
  diarization: "Identifierar talare",
  transcription: "Transkriberar",
  formatting: "Formaterar output",
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ProcessingView({
  stage,
  percent,
  message,
  isIndeterminate,
  lastEventTime,
  startTime,
  eventLog,
}: Props) {
  const label = STAGE_LABELS[stage] ?? message ?? "Startar...";

  // Elapsed time ticker
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = startTime > 0 ? Math.floor((now - startTime) / 1000) : 0;
  const sinceLast = lastEventTime > 0 ? Math.floor((now - lastEventTime) / 1000) : 0;
  const isStale = sinceLast > 60;

  return (
    <div className="max-w-md mx-auto mt-24 animate-fade-in">
      <div className="glass-elevated rounded-2xl p-8 space-y-6 text-center">
        {/* Spinner */}
        <div className="flex justify-center">
          <div
            className="w-16 h-16 rounded-full animate-spin"
            style={{
              border: "4px solid rgba(255,255,255,0.06)",
              borderTopColor: "var(--color-primary)",
              boxShadow: "0 0 20px rgba(37, 99, 235, 0.2)",
            }}
          />
        </div>

        {/* Stage label with elapsed time */}
        <div>
          <p className="text-lg font-medium">
            {label}
            {elapsedSec > 0 && (
              <span className="text-[var(--color-text-muted)] font-normal">
                {" "}({formatElapsed(elapsedSec)})
              </span>
            )}
          </p>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {isIndeterminate ? "Bearbetar..." : `${percent}%`}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2 glass rounded-full overflow-hidden">
          {isIndeterminate ? (
            <div
              className="h-full rounded-full"
              style={{
                width: "40%",
                background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                boxShadow: "0 0 12px rgba(37, 99, 235, 0.4)",
                animation: "indeterminate-slide 1.5s ease-in-out infinite",
              }}
            />
          ) : (
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${percent}%`,
                background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                boxShadow: "0 0 12px rgba(37, 99, 235, 0.4)",
              }}
            />
          )}
        </div>

        {/* Last signal indicator */}
        {lastEventTime > 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Senaste signal: {sinceLast < 2 ? "just nu" : `${sinceLast}s sedan`}
          </p>
        )}

        {/* Staleness warning */}
        {isStale && (
          <div className="text-xs text-yellow-400 bg-yellow-400/10 rounded-lg px-3 py-2">
            Inget svar pa {sinceLast}s — processen kan vara upptagen med ett tungt steg
          </div>
        )}

        {/* Event log */}
        {eventLog.length > 0 && (
          <div className="text-left space-y-1 pt-2 border-t border-white/5">
            <p className="text-xs text-[var(--color-text-muted)] font-medium mb-1">
              Senaste handelser
            </p>
            {eventLog
              .slice()
              .reverse()
              .slice(0, 3)
              .map((entry, i) => {
                const ago = Math.max(0, Math.floor((now - entry.time) / 1000));
                return (
                  <p key={i} className="text-xs text-[var(--color-text-muted)] truncate">
                    <span className="opacity-50">{ago < 2 ? "nu" : `${ago}s sedan`}</span>
                    {" "}
                    {entry.message}
                  </p>
                );
              })}
          </div>
        )}
      </div>

      <style>{`
        @keyframes indeterminate-slide {
          0% { margin-left: 0%; }
          50% { margin-left: 60%; }
          100% { margin-left: 0%; }
        }
      `}</style>
    </div>
  );
}
