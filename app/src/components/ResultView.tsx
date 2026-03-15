import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

interface Summary {
  total_duration: number;
  speech_duration: number;
  processing_time: number;
  num_speakers: number;
  num_segments: number;
}

interface Props {
  status: "done" | "error" | string;
  error: string | null;
  outputFiles: string[];
  summary: Summary | null;
  onBack: () => void;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} sek` : `${s} sek`;
}

function renderMarkdown(content: string) {
  return content.split("\n").map((line, i) => {
    // Header lines (# ...)
    if (line.startsWith("# ")) {
      return (
        <h1 key={i} className="text-xl font-bold mb-3">
          {line.slice(2)}
        </h1>
      );
    }
    if (line.startsWith("## ")) {
      return (
        <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
          {line.slice(3)}
        </h2>
      );
    }
    // Bold speaker + timestamp lines: **[HH:MM:SS] Talare N:**
    if (line.startsWith("**") && line.includes(":**")) {
      const boldEnd = line.indexOf(":**") + 3;
      const label = line.slice(2, boldEnd - 2);
      const rest = line.slice(boldEnd);
      return (
        <p key={i} className="mt-3 mb-1">
          <strong className="text-[var(--color-primary)]">{label}</strong>
          {rest}
        </p>
      );
    }
    // Horizontal rule
    if (line.match(/^-{3,}$/)) {
      return <hr key={i} className="my-3 border-[var(--color-border)]" />;
    }
    // Empty line
    if (line.trim() === "") {
      return <div key={i} className="h-2" />;
    }
    // Regular text
    return (
      <p key={i} className="leading-relaxed">
        {line}
      </p>
    );
  });
}

export default function ResultView({
  status,
  error,
  outputFiles,
  summary,
  onBack,
}: Props) {
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const mdFile = outputFiles.find((f) => f.endsWith(".md"));

  useEffect(() => {
    if (!mdFile) return;
    invoke<string>("read_file_content", { path: mdFile })
      .then(setMdContent)
      .catch((err) => setLoadError(String(err)));
  }, [mdFile]);

  const handleOpen = async (path: string) => {
    try {
      await invoke("open_file", { path });
    } catch (err) {
      console.error("Could not open file:", err);
    }
  };

  const handleSaveAs = async () => {
    if (!mdFile) return;
    const defaultName = mdFile.split(/[\\/]/).pop() ?? "transkribering.md";
    try {
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!dest) return; // user cancelled
      setSaving(true);
      await invoke("copy_file_to", { source: mdFile, destination: dest });
    } catch (err) {
      console.error("Could not save file:", err);
    } finally {
      setSaving(false);
    }
  };

  if (status === "error") {
    return (
      <div className="max-w-xl mx-auto mt-16 space-y-6">
        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30">
          <h3 className="text-[var(--color-error)] font-medium">Fel vid transkribering</h3>
          <p className="text-sm mt-1 text-[var(--color-text-muted)]">{error}</p>
        </div>
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-sm transition-colors"
        >
          Tillbaka
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto mt-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-[var(--color-success)]/20 flex items-center justify-center">
          <svg className="w-5 h-5 text-[var(--color-success)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold">Transkribering klar</h2>
      </div>

      {/* Summary */}
      {summary && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Längd", value: formatTime(summary.total_duration) },
            { label: "Bearbetning", value: formatTime(summary.processing_time) },
            { label: "Talare", value: String(summary.num_speakers) },
            { label: "Segment", value: String(summary.num_segments) },
          ].map((item) => (
            <div
              key={item.label}
              className="p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]"
            >
              <p className="text-xs text-[var(--color-text-muted)]">{item.label}</p>
              <p className="text-lg font-semibold mt-0.5">{item.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Transcription content */}
      {mdContent !== null && (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 max-h-96 overflow-y-auto text-sm">
          {renderMarkdown(mdContent)}
        </div>
      )}
      {loadError && (
        <p className="text-sm text-[var(--color-text-muted)]">
          Kunde inte visa transkriptionen: {loadError}
        </p>
      )}

      {/* Action buttons */}
      <div className="flex gap-3 flex-wrap">
        {mdFile && (
          <button
            onClick={handleSaveAs}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 text-sm transition-colors disabled:opacity-50"
          >
            {saving ? "Sparar..." : "Spara som\u2026"}
          </button>
        )}
        {outputFiles.map((f) => {
          const name = f.split(/[\\/]/).pop() ?? f;
          return (
            <button
              key={f}
              onClick={() => handleOpen(f)}
              className="px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-sm transition-colors"
            >
              Öppna {name}
            </button>
          );
        })}
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-sm transition-colors"
        >
          Ny transkribering
        </button>
      </div>
    </div>
  );
}
