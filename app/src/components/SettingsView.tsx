import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { OllamaStatus } from "../hooks/useOllama";
import { usePromptTemplates } from "../hooks/usePromptTemplates";
import { PROMPT_TEMPLATES } from "../data/promptTemplates";

interface Settings {
  defaultModel: string;
  defaultNumSpeakers: string;
  defaultFormats: { markdown: boolean; json: boolean; docx: boolean };
  vadEnabled: boolean;
  defaultSpeedProfile: string;
}

const STORAGE_KEY = "motesskribent-settings";

function loadSettings(): Settings {
  const defaults: Settings = {
    defaultModel: "KBLab/kb-whisper-base",
    defaultNumSpeakers: "",
    defaultFormats: { markdown: true, json: true, docx: false },
    vadEnabled: true,
    defaultSpeedProfile: "balanced",
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migrera gammal default small → base
      if (parsed.defaultModel === "KBLab/kb-whisper-small") {
        parsed.defaultModel = "KBLab/kb-whisper-base";
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      return {
        ...defaults,
        ...parsed,
        defaultFormats: { ...defaults.defaultFormats, ...parsed.defaultFormats },
      };
    }
  } catch {}
  return defaults;
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

function formatFileSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
}

export default function SettingsView({ ollamaStatus }: { ollamaStatus: OllamaStatus }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checking, setChecking] = useState(false);

  const flashSaved = () => {
    setShowSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setShowSaved(false), 1500);
  };

  useEffect(() => {
    return () => { if (savedTimerRef.current) clearTimeout(savedTimerRef.current); };
  }, []);

  // Prompt template management
  const promptHook = usePromptTemplates();
  const editableTemplates = promptHook.templates.filter((t) => !t.isCustom);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editTemplate, setEditTemplate] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
    flashSaved();
  };

  const startEdit = (id: string) => {
    const t = promptHook.templates.find((t) => t.id === id);
    if (!t) return;
    setEditingId(id);
    setEditName(t.name);
    setEditDesc(t.description);
    setEditTemplate(t.template);
    setCreatingNew(false);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setCreatingNew(false);
  };

  const saveEdit = () => {
    if (!editingId) return;
    const changes = { name: editName, description: editDesc, template: editTemplate };
    if (promptHook.isUserTemplate(editingId)) {
      promptHook.updateUserTemplate(editingId, changes);
    } else {
      promptHook.updateBuiltIn(editingId, changes);
    }
    setEditingId(null);
  };

  const startCreate = () => {
    setCreatingNew(true);
    setEditingId(null);
    setEditName("");
    setEditDesc("");
    setEditTemplate("");
  };

  const saveCreate = () => {
    if (!editName.trim()) return;
    promptHook.createTemplate({
      name: editName,
      description: editDesc,
      template: editTemplate,
    });
    setCreatingNew(false);
  };

  return (
    <div className="max-w-xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <h2 className="text-2xl font-bold">Inställningar</h2>
        {showSaved && (
          <span className="text-sm text-[var(--color-success)] animate-saved-flash">
            Sparad
          </span>
        )}
      </div>

      {/* Default model */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standardmodell</label>
        <select
          value={settings.defaultModel}
          onChange={(e) => update("defaultModel", e.target.value)}
          className="w-full px-3 py-2 rounded-lg glass-input text-sm"
        >
          <option value="KBLab/kb-whisper-tiny">Tiny (~160 MB) — snabbast</option>
          <option value="KBLab/kb-whisper-base">Base (~240 MB) — rekommenderas</option>
          <option value="KBLab/kb-whisper-small">Small (~460 MB)</option>
          <option value="KBLab/kb-whisper-medium">Medium (~1.5 GB)</option>
          <option value="KBLab/kb-whisper-large">Large (~3 GB)</option>
        </select>
      </div>

      {/* Default speakers */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standard antal talare</label>
        <input
          type="number"
          min={1}
          max={20}
          placeholder="Auto"
          value={settings.defaultNumSpeakers}
          onChange={(e) => update("defaultNumSpeakers", e.target.value)}
          className="w-32 px-3 py-2 rounded-lg glass-input text-sm"
        />
      </div>

      {/* Default formats */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standardformat</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.defaultFormats.markdown}
              onChange={(e) =>
                update("defaultFormats", { ...settings.defaultFormats, markdown: e.target.checked })
              }
              className="accent-[var(--color-primary)]"
            />
            Markdown
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.defaultFormats.json}
              onChange={(e) =>
                update("defaultFormats", { ...settings.defaultFormats, json: e.target.checked })
              }
              className="accent-[var(--color-primary)]"
            />
            JSON
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.defaultFormats.docx ?? false}
              onChange={(e) =>
                update("defaultFormats", { ...settings.defaultFormats, docx: e.target.checked })
              }
              className="accent-[var(--color-primary)]"
            />
            Word (.docx)
          </label>
        </div>
      </div>

      {/* Speed profile */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standard hastighetsprofil</label>
        <div className="flex rounded-lg overflow-hidden border border-white/10">
          {([
            { id: "fast", label: "Snabb" },
            { id: "balanced", label: "Balanserad" },
            { id: "quality", label: "H\u00f6g kvalitet" },
          ] as const).map((p) => (
            <button
              key={p.id}
              onClick={() => update("defaultSpeedProfile", p.id)}
              className={`flex-1 px-3 py-2 text-sm transition-colors ${
                settings.defaultSpeedProfile === p.id
                  ? "bg-[var(--color-primary)] text-white"
                  : "glass hover:bg-white/5 text-[var(--color-text-muted)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* VAD */}
      <div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.vadEnabled}
            onChange={(e) => update("vadEnabled", e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          VAD-filtrering (rekommenderas)
        </label>
      </div>

      {/* Meeting detection */}
      <MeetingDetectionSection />

      {/* Ollama */}
      <div className="space-y-3 pt-4 border-t border-white/10">
        <h3 className="text-lg font-semibold">Ollama (lokal LLM)</h3>

        {/* Server URL */}
        <div className="space-y-1">
          <label className="block text-xs text-[var(--color-text-muted)]">Server-URL</label>
          <input
            type="text"
            value={ollamaStatus.ollamaUrl}
            onChange={(e) => ollamaStatus.setOllamaUrl(e.target.value)}
            placeholder="http://localhost:11434"
            className="w-full px-3 py-2 rounded-lg glass-input text-sm"
          />
          <p className="text-[10px] text-[var(--color-text-muted)]">
            Standard: http://localhost:11434. Ändra om Ollama körs på en annan dator eller port.
          </p>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            {ollamaStatus.available === null ? (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-400 animate-pulse" />
                <span className="text-[var(--color-text-muted)]">Kontrollerar...</span>
              </>
            ) : ollamaStatus.available ? (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
                <span className="text-green-400">Ansluten</span>
              </>
            ) : (
              <>
                <div className="w-2.5 h-2.5 rounded-full bg-gray-500" />
                <span className="text-[var(--color-text-muted)]">Ej ansluten</span>
              </>
            )}
          </div>
          <button
            onClick={async () => {
              setChecking(true);
              await ollamaStatus.checkHealth();
              setChecking(false);
            }}
            disabled={checking}
            className="px-3 py-1 rounded-lg glass hover:bg-white/5 text-xs transition-colors disabled:opacity-50"
          >
            {checking ? "Kontrollerar..." : "Testa anslutning"}
          </button>
        </div>

        {/* Help text when not connected */}
        {ollamaStatus.available === false && (
          <p className="text-xs text-[var(--color-text-muted)]">
            Installera Ollama fran{" "}
            <span className="text-[var(--color-primary)]">ollama.com</span>{" "}
            och starta tjansten for att anvanda lokal LLM-bearbetning.
          </p>
        )}

        {/* Model selector when connected */}
        {ollamaStatus.available === true && (
          <div className="space-y-2">
            <label className="block text-sm text-[var(--color-text-muted)]">Standardmodell for Ollama</label>
            {ollamaStatus.models.length > 0 ? (
              <select
                value={ollamaStatus.selectedModel ?? ""}
                onChange={(e) => ollamaStatus.selectModel(e.target.value)}
                className="w-full px-3 py-2 rounded-lg glass-input text-sm"
              >
                {ollamaStatus.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} ({formatFileSize(m.size)})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-[var(--color-text-muted)]">
                Inga modeller installerade. Ladda ner med:{" "}
                <code className="text-[var(--color-primary)]">ollama pull llama3.2</code>
              </p>
            )}
          </div>
        )}

        {/* Ollama generation parameters */}
        {ollamaStatus.available === true && (
          <OllamaParametersSection />
        )}
      </div>

      {/* Prompt templates */}
      <div className="space-y-3 pt-4 border-t border-white/10">
        <h3 className="text-lg font-semibold">Promptmallar</h3>
        <p className="text-xs text-[var(--color-text-muted)]">
          Hantera promptmallar som visas under "Bearbeta transkribering" i resultatvyn.
        </p>

        <div className="space-y-2">
          {editableTemplates.map((t) => {
            const isBuiltIn = PROMPT_TEMPLATES.some((b) => b.id === t.id && !b.isCustom);
            const isUser = promptHook.isUserTemplate(t.id);
            const overridden = isBuiltIn && promptHook.isOverridden(t.id);
            const isEditing = editingId === t.id;

            return (
              <div key={t.id} className="rounded-lg glass overflow-hidden">
                {/* Row */}
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{t.name}</span>
                      {overridden && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-primary)]/20 text-[var(--color-primary)]">
                          Anpassad
                        </span>
                      )}
                      {isUser && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-emerald-500/20 text-emerald-400">
                          Egen
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--color-text-muted)] truncate">{t.description}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {overridden && (
                      <button
                        onClick={() => promptHook.resetBuiltIn(t.id)}
                        className="px-2 py-1 rounded text-[11px] glass hover:bg-white/5 transition-colors text-[var(--color-text-muted)]"
                      >
                        Återställ
                      </button>
                    )}
                    <button
                      onClick={() => (isEditing ? cancelEdit() : startEdit(t.id))}
                      className="px-2 py-1 rounded text-[11px] glass hover:bg-white/5 transition-colors"
                    >
                      {isEditing ? "Stäng" : "Redigera"}
                    </button>
                    {isUser && (
                      <button
                        onClick={() => promptHook.deleteTemplate(t.id)}
                        className="px-2 py-1 rounded text-[11px] glass hover:bg-red-500/10 transition-colors text-red-400"
                      >
                        Ta bort
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline edit form */}
                {isEditing && (
                  <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
                    <div>
                      <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Namn</label>
                      <input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="w-full px-2 py-1.5 rounded-lg glass-input text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Beskrivning</label>
                      <input
                        value={editDesc}
                        onChange={(e) => setEditDesc(e.target.value)}
                        className="w-full px-2 py-1.5 rounded-lg glass-input text-sm"
                      />
                    </div>
                    <div>
                      <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Promptmall</label>
                      <textarea
                        value={editTemplate}
                        onChange={(e) => setEditTemplate(e.target.value)}
                        rows={6}
                        className="w-full px-2 py-1.5 rounded-lg glass-input text-sm resize-none font-mono"
                      />
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                        {"{transcription}"} = transkriberingen, {"{context}"} = extra kontext
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={saveEdit}
                        className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs transition-all"
                      >
                        Spara
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="px-3 py-1.5 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
                      >
                        Avbryt
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Create new form */}
        {creatingNew ? (
          <div className="rounded-lg glass p-3 space-y-2">
            <p className="text-sm font-medium">Ny promptmall</p>
            <div>
              <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Namn</label>
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder="T.ex. Dagordning"
                className="w-full px-2 py-1.5 rounded-lg glass-input text-sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Beskrivning</label>
              <input
                value={editDesc}
                onChange={(e) => setEditDesc(e.target.value)}
                placeholder="Kort beskrivning av vad prompten gör"
                className="w-full px-2 py-1.5 rounded-lg glass-input text-sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Promptmall</label>
              <textarea
                value={editTemplate}
                onChange={(e) => setEditTemplate(e.target.value)}
                placeholder="Skriv din promptmall här. Använd {transcription} och {context} som platshållare."
                rows={6}
                className="w-full px-2 py-1.5 rounded-lg glass-input text-sm resize-none font-mono"
              />
              <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                {"{transcription}"} = transkriberingen, {"{context}"} = extra kontext
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={saveCreate}
                disabled={!editName.trim()}
                className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs transition-all disabled:opacity-50"
              >
                Skapa
              </button>
              <button
                onClick={cancelEdit}
                className="px-3 py-1.5 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
              >
                Avbryt
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={startCreate}
            className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-sm transition-colors text-[var(--color-text-muted)] hover:text-[var(--color-text)] border border-dashed border-white/10"
          >
            + Skapa ny promptmall
          </button>
        )}
      </div>
    </div>
  );
}

const OLLAMA_OPTIONS_KEY = "motesskribent-ollama-options";

interface OllamaOptionsState {
  temperature: number;
  num_ctx: number;
  num_predict: number;
}

function loadOllamaOptions(): OllamaOptionsState {
  try {
    const raw = localStorage.getItem(OLLAMA_OPTIONS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { temperature: 0.3, num_ctx: 4096, num_predict: 2048 };
}

function OllamaParametersSection() {
  const [opts, setOpts] = useState<OllamaOptionsState>(loadOllamaOptions);

  const update = (key: keyof OllamaOptionsState, value: number) => {
    setOpts((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem(OLLAMA_OPTIONS_KEY, JSON.stringify(next));
      return next;
    });
  };

  return (
    <div className="space-y-3 pt-3">
      <p className="text-sm text-[var(--color-text-muted)] font-medium">Genereringsparametrar</p>

      {/* Temperature */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-[var(--color-text-muted)]">Temperatur</label>
          <span className="text-xs text-[var(--color-text-muted)]">{opts.temperature.toFixed(1)}</span>
        </div>
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={opts.temperature * 10}
          onChange={(e) => update("temperature", Number(e.target.value) / 10)}
          className="result-range w-full"
        />
        <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
          Lagre = mer fokuserad, hogre = mer kreativ. Standard: 0.3
        </p>
      </div>

      {/* Context window */}
      <div>
        <label className="text-xs text-[var(--color-text-muted)] block mb-1">Kontextfonster (num_ctx)</label>
        <select
          value={opts.num_ctx}
          onChange={(e) => update("num_ctx", Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg glass-input text-sm"
        >
          <option value={2048}>2 048</option>
          <option value={4096}>4 096 (standard)</option>
          <option value={8192}>8 192</option>
          <option value={16384}>16 384</option>
          <option value={32768}>32 768</option>
        </select>
      </div>

      {/* Max tokens */}
      <div>
        <label className="text-xs text-[var(--color-text-muted)] block mb-1">Max tokens (num_predict)</label>
        <select
          value={opts.num_predict}
          onChange={(e) => update("num_predict", Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg glass-input text-sm"
        >
          <option value={512}>512</option>
          <option value={1024}>1 024</option>
          <option value={2048}>2 048 (standard)</option>
          <option value={4096}>4 096</option>
          <option value={8192}>8 192</option>
        </select>
      </div>
    </div>
  );
}

const MEETING_DETECTION_KEY = "meetingDetectionEnabled";

function MeetingDetectionSection() {
  const [enabled, setEnabled] = useState(() => {
    return localStorage.getItem(MEETING_DETECTION_KEY) === "true";
  });

  // Sync with backend on mount
  useEffect(() => {
    if (enabled) {
      invoke("set_meeting_detection", { enabled: true }).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (checked: boolean) => {
    setEnabled(checked);
    localStorage.setItem(MEETING_DETECTION_KEY, String(checked));
    try {
      await invoke("set_meeting_detection", { enabled: checked });
    } catch (e) {
      console.error("Kunde inte ändra mötesdetektering:", e);
    }
  };

  return (
    <div className="space-y-3 pt-4 border-t border-white/10">
      <h3 className="text-lg font-semibold">Mötesdetektering</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => toggle(e.target.checked)}
          className="accent-[var(--color-primary)]"
        />
        Upptäck Teams-möten automatiskt
      </label>
      <p className="text-xs text-[var(--color-text-muted)]">
        Övervakar om ett Microsoft Teams-möte startar och visar en notis som frågar om du vill spela in.
        Appen måste köra i bakgrunden (systemfältet) för att detta ska fungera.
      </p>
    </div>
  );
}
