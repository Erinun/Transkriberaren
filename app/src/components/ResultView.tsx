import { useState } from "react";
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
  mdContent: string | null;
  warnings: string[];
  onBack: () => void;
}

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
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
  mdContent,
  warnings,
  onBack,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);

  const mdFile = outputFiles.find((f) => f.endsWith(".md"));
  const docxFile = outputFiles.find((f) => f.endsWith(".docx"));

  const handleOpen = async (path: string) => {
    try {
      await invoke("open_file", { path });
    } catch (err) {
      console.error("Could not open file:", err);
    }
  };

  const handleSaveAs = async () => {
    if (!mdContent) return;
    const defaultName = mdFile
      ? mdFile.split(/[\\/]/).pop() ?? "transkribering.md"
      : "transkribering.md";
    try {
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!dest) return;
      setSaving(true);
      await invoke("write_text_to_file", { content: mdContent, destination: dest });
    } catch (err) {
      console.error("Could not save file:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDocx = async () => {
    if (!docxFile) return;
    const defaultName = docxFile.split(/[\\/]/).pop() ?? "transkribering.docx";
    try {
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Word-dokument", extensions: ["docx"] }],
      });
      if (!dest) return;
      setSaving(true);
      await invoke("copy_file_to", { source: docxFile, destination: dest });
    } catch (err) {
      console.error("Could not save docx:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    if (!mdContent) return;
    try {
      await navigator.clipboard.writeText(mdContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Could not copy:", err);
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

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          {warnings.map((w, i) => (
            <p key={i} className="text-sm text-yellow-200">{w}</p>
          ))}
        </div>
      )}

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

      {/* Action buttons */}
      <div className="flex gap-3 flex-wrap">
        {mdContent && (
          <button
            onClick={handleSaveAs}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 text-sm transition-colors disabled:opacity-50"
          >
            {saving ? "Sparar..." : "Spara som\u2026"}
          </button>
        )}
        {docxFile && (
          <button
            onClick={handleSaveDocx}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:opacity-90 text-sm transition-colors disabled:opacity-50"
          >
            {saving ? "Sparar..." : "Spara som Word\u2026"}
          </button>
        )}
        {mdContent && (
          <button
            onClick={handleCopy}
            className="px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-sm transition-colors"
          >
            {copied ? "Kopierat!" : "Kopiera text"}
          </button>
        )}
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
