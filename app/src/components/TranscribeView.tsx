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
  { id: "KBLab/kb-whisper-tiny", label: "Tiny (~160 MB)", desc: "Snabbast", tip: "Snabba anteckningar, korta möten (<15 min), enkel dialog med 1\u20132 talare" },
  { id: "KBLab/kb-whisper-base", label: "Base (~240 MB)", desc: "Rekommenderas", tip: "De flesta möten \u2014 bra balans mellan hastighet och kvalitet. Fungerar bra för teammöten, intervjuer och workshops" },
  { id: "KBLab/kb-whisper-small", label: "Small (~460 MB)", desc: "Bra balans", tip: "Längre möten med många talare, brusiga inspelningar, eller när hög noggrannhet krävs" },
];

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} sek` : `${s} sek`;
}

const SETTINGS_KEY = "motesskribent-settings";

function loadDefaultSettings() {
  const defaults = {
    model: "KBLab/kb-whisper-base",
    numSpeakers: "",
    formats: { markdown: true, json: true, docx: false },
    vadEnabled: true,
    speedProfile: "balanced",
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Migrera ogiltiga modeller → base
      const validModels = ["KBLab/kb-whisper-tiny", "KBLab/kb-whisper-base", "KBLab/kb-whisper-small"];
      if (s.defaultModel && !validModels.includes(s.defaultModel)) {
        s.defaultModel = "KBLab/kb-whisper-base";
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
      }
      if (s.defaultModel) defaults.model = s.defaultModel;
      if (s.defaultNumSpeakers) defaults.numSpeakers = s.defaultNumSpeakers;
      if (s.defaultFormats) defaults.formats = { ...defaults.formats, ...s.defaultFormats };
      if (typeof s.vadEnabled === "boolean") defaults.vadEnabled = s.vadEnabled;
      if (s.defaultSpeedProfile) defaults.speedProfile = s.defaultSpeedProfile;
    }
  } catch {}
  return defaults;
}

export default function TranscribeView({ onStart, history, onViewHistory, diarizationAvailable }: Props) {
  const defaults = loadDefaultSettings();
  const [filePath, setFilePath] = useState<string | null>(null);
  const [model, setModel] = useState(defaults.model);
  const [numSpeakers, setNumSpeakers] = useState<string>(defaults.numSpeakers);
  const [formats, setFormats] = useState(defaults.formats);
  const [outputDir, setOutputDir] = useState("");
  const [vadEnabled, setVadEnabled] = useState(defaults.vadEnabled);
  const [speedProfile, setSpeedProfile] = useState(defaults.speedProfile);
  const [showModelInfo, setShowModelInfo] = useState(false);

  useEffect(() => {
    invoke<string>("get_default_output_dir").then(setOutputDir);
  }, []);

  const handlePickFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [
          { name: "Ljud", extensions: ["wav", "mp3", "m4a", "flac", "ogg", "wma"] },
        ],
      });
      if (selected) {
        setFilePath(selected);
      }
    } catch (err) {
      console.error("Filväljaren misslyckades:", err);
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
      speedProfile,
      audioSource: null,
    });
  };

  return (
    <div className="max-w-xl mx-auto space-y-6 animate-fade-in">
      <h2 className="text-2xl font-bold">Transkribera ljudfil</h2>

      {/* File picker — drop zone style */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Ljudfil</label>
        <button
          onClick={handlePickFile}
          className="w-full p-6 rounded-xl border-2 border-dashed border-[rgba(255,255,255,0.1)] hover:border-[var(--color-primary)] hover:bg-white/[0.02] transition-all flex flex-col items-center gap-2 group"
        >
          <svg className="w-8 h-8 text-[var(--color-text-muted)] group-hover:text-[var(--color-primary)] transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
          </svg>
          <span className="text-sm text-[var(--color-text-muted)] group-hover:text-[var(--color-text)] transition-colors">
            {filePath ? filePath.split(/[\\/]/).pop() : "Klicka för att välja fil..."}
          </span>
        </button>
      </div>

      {/* Model */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <label className="block text-sm text-[var(--color-text-muted)]">Modell</label>
          <button
            type="button"
            onClick={() => setShowModelInfo((v) => !v)}
            className="w-4 h-4 rounded-full border border-[var(--color-text-muted)] flex items-center justify-center text-[10px] leading-none text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:border-[var(--color-primary)] transition-colors"
            title="Visa modellrekommendationer"
          >
            i
          </button>
        </div>
        {showModelInfo && (
          <div className="glass rounded-lg p-3 space-y-2">
            <p className="text-xs font-medium text-[var(--color-text-muted)]">Vilken modell passar ditt möte?</p>
            {MODELS.map((m) => (
              <div key={m.id} className="text-xs text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text)]">{m.label.split(" ")[0]}</span>
                {" \u2014 "}
                {m.tip}
              </div>
            ))}
          </div>
        )}
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 rounded-lg glass-input text-sm"
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.desc}
            </option>
          ))}
        </select>
      </div>

      {/* Speed profile */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Hastighetsprofil</label>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {([
            { id: "fast", label: "Snabb", desc: "Snabbast" },
            { id: "balanced", label: "Balanserad", desc: "Rekommenderas" },
            { id: "quality", label: "H\u00f6g kvalitet", desc: "Noggrannast" },
          ] as const).map((p) => (
            <button
              key={p.id}
              onClick={() => setSpeedProfile(p.id)}
              className={`flex-1 px-3 py-2 text-sm transition-colors ${
                speedProfile === p.id
                  ? "bg-[var(--color-primary)] text-white"
                  : "glass hover:bg-white/5 text-[var(--color-text-muted)]"
              }`}
            >
              <div className="font-medium">{p.label}</div>
              <div className="text-xs opacity-70">{p.desc}</div>
            </button>
          ))}
        </div>
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
          className={`w-32 px-3 py-2 rounded-lg glass-input text-sm ${
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
        className={`w-full py-3 rounded-lg font-medium text-sm transition-all ${
          filePath
            ? "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white hover:glow-primary hover:shadow-[0_0_20px_rgba(37,99,235,0.25)]"
            : "glass text-[var(--color-text-muted)] cursor-not-allowed"
        }`}
      >
        Transkribera
      </button>

      {/* History */}
      {history.length > 0 && (
        <div className="space-y-3 pt-4 border-t border-white/5">
          <h3 className="text-sm font-medium text-[var(--color-text-muted)]">
            Senaste transkriptioner
          </h3>
          <div className="space-y-2">
            {history.map((entry) => (
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
                <button
                  onClick={() => onViewHistory(entry)}
                  className="ml-3 px-3 py-1.5 rounded-md text-xs glass hover:bg-white/5 transition-colors"
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
