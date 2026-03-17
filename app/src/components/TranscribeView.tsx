import { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { PipelineSettings } from "../hooks/usePipeline";
import type { HistoryEntry } from "../hooks/useHistory";

interface Props {
  onStart: (filePath: string, settings: PipelineSettings) => void;
  history: HistoryEntry[];
  onViewHistory: (entry: HistoryEntry) => void;
  diarizationAvailable: boolean;
}

const MODELS = [
  { id: "KBLab/kb-whisper-small", label: "Small (~460 MB)", desc: "Bra balans" },
  { id: "KBLab/kb-whisper-medium", label: "Medium (~1.5 GB)", desc: "Bättre kvalitet" },
  { id: "KBLab/kb-whisper-large", label: "Large (~3 GB)", desc: "Bäst kvalitet" },
];

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} sek` : `${s} sek`;
}

export default function TranscribeView({ onStart, history, onViewHistory, diarizationAvailable }: Props) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [model, setModel] = useState("KBLab/kb-whisper-small");
  const [numSpeakers, setNumSpeakers] = useState<string>("");
  const [formats, setFormats] = useState({ markdown: true, json: true, docx: false });
  const [outputDir, setOutputDir] = useState("");
  const [vadEnabled, setVadEnabled] = useState(true);

  useEffect(() => {
    invoke<string>("get_default_output_dir").then(setOutputDir);
  }, []);

  const handlePickFile = async () => {
    const selected = await open({
      multiple: false,
      filters: [
        { name: "Ljud", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "wma"] },
      ],
    });
    if (selected) {
      setFilePath(selected);
    }
  };

  const handleStart = () => {
    if (!filePath) return;
    const fmtList: string[] = [];
    if (formats.markdown) fmtList.push("markdown");
    if (formats.json) fmtList.push("json");
    if (formats.docx) fmtList.push("docx");

    onStart(filePath, {
      model,
      numSpeakers: numSpeakers ? parseInt(numSpeakers) : null,
      formats: fmtList,
      outputDir,
      vadEnabled,
      prompt: null,
    });
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">Transkribera ljudfil</h2>

      {/* File picker */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Ljudfil</label>
        <div className="flex gap-3">
          <button
            onClick={handlePickFile}
            className="px-4 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors text-sm"
          >
            Välj fil...
          </button>
          <span className="py-2 text-sm text-[var(--color-text-muted)] truncate flex-1">
            {filePath ?? "Ingen fil vald"}
          </span>
        </div>
      </div>

      {/* Model */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Modell</label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-primary)]"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.desc}
            </option>
          ))}
        </select>
      </div>

      {/* Speakers */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Antal talare</label>
        <input
          type="number"
          min={1}
          max={20}
          placeholder={diarizationAvailable ? "Auto" : "1"}
          value={diarizationAvailable ? numSpeakers : ""}
          onChange={(e) => setNumSpeakers(e.target.value)}
          disabled={!diarizationAvailable}
          className={`w-32 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-primary)] ${
            !diarizationAvailable ? "opacity-50 cursor-not-allowed" : ""
          }`}
        />
        {!diarizationAvailable && (
          <p className="text-xs text-yellow-400">
            Talarseparering ej tillgänglig — diariseringsmodellen kunde inte laddas.
            Transkribering fungerar men utan talaridentifiering.
          </p>
        )}
      </div>

      {/* Format */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Format</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formats.markdown}
              onChange={(e) => setFormats((f) => ({ ...f, markdown: e.target.checked }))}
              className="accent-[var(--color-primary)]"
            />
            Markdown
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formats.json}
              onChange={(e) => setFormats((f) => ({ ...f, json: e.target.checked }))}
              className="accent-[var(--color-primary)]"
            />
            JSON
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={formats.docx}
              onChange={(e) => setFormats((f) => ({ ...f, docx: e.target.checked }))}
              className="accent-[var(--color-primary)]"
            />
            Word (.docx)
          </label>
        </div>
      </div>

      {/* VAD */}
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={vadEnabled}
            onChange={(e) => setVadEnabled(e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          VAD-filtrering (rekommenderas)
        </label>
      </div>

      {/* Start button */}
      <button
        onClick={handleStart}
        disabled={!filePath}
        className={`w-full py-3 rounded-lg font-medium text-sm transition-colors ${
          filePath
            ? "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
            : "bg-[var(--color-surface)] text-[var(--color-text-muted)] cursor-not-allowed"
        }`}
      >
        Transkribera
      </button>

      {/* History */}
      {history.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-[var(--color-border)]">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">
            Senaste transkriptioner
          </h3>
          <div className="space-y-2">
            {history.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{entry.audioName}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {new Date(entry.date).toLocaleDateString("sv-SE")}
                    {" \u00b7 "}
                    {formatTime(entry.summary.total_duration)}
                    {" \u00b7 "}
                    {entry.summary.num_speakers} talare
                  </p>
                </div>
                <button
                  onClick={() => onViewHistory(entry)}
                  className="ml-3 px-3 py-1.5 rounded-md text-xs bg-[var(--color-surface-hover)] hover:bg-[var(--color-border)] transition-colors"
                >
                  Visa
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
