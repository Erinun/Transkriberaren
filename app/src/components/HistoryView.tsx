import { useState } from "react";
import type { HistoryEntry } from "../hooks/useHistory";

interface Props {
  entries: HistoryEntry[];
  onView: (entry: HistoryEntry) => void;
  onRemove: (id: string) => void;
}

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} sek` : `${s} sek`;
}

export default function HistoryView({ entries, onView, onRemove }: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  return (
    <div className="max-w-xl mx-auto space-y-6 animate-fade-in">
      <h2 className="text-2xl font-bold">Transkriptioner</h2>

      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-[var(--color-text-muted)]">
          <svg className="w-12 h-12 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <p className="text-sm">Inga transkriptioner ännu</p>
          <p className="text-xs">Transkriberade möten visas här</p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex items-center justify-between p-3 rounded-xl glass"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{entry.audioName}</p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {new Date(entry.date).toLocaleDateString("sv-SE")}
                  {" \u00b7 "}
                  {formatTime(entry.summary.total_duration)}
                  {" \u00b7 "}
                  {entry.summary.num_speakers} talare
                  {entry.ollamaResults && entry.ollamaResults.length > 0 && (
                    <>
                      {" \u00b7 "}
                      <span className="text-[var(--color-primary)]">
                        {entry.ollamaResults.length} bearbetning{entry.ollamaResults.length > 1 ? "ar" : ""}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 ml-3">
                {confirmId === entry.id ? (
                  <>
                    <span className="text-xs text-[var(--color-text-muted)]">Ta bort?</span>
                    <button
                      onClick={() => {
                        onRemove(entry.id);
                        setConfirmId(null);
                      }}
                      className="px-2 py-1 rounded-md text-xs bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                    >
                      Ja
                    </button>
                    <button
                      onClick={() => setConfirmId(null)}
                      className="px-2 py-1 rounded-md text-xs glass hover:bg-white/5 transition-colors"
                    >
                      Nej
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => onView(entry)}
                      className="px-3 py-1.5 rounded-md text-xs glass hover:bg-white/5 transition-colors"
                    >
                      Visa
                    </button>
                    <button
                      onClick={() => setConfirmId(entry.id)}
                      className="px-2 py-1.5 rounded-md text-xs text-[var(--color-text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
                      title="Ta bort"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
