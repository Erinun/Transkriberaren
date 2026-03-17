import { useState } from "react";
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {
    defaultModel: "KBLab/kb-whisper-small",
    defaultNumSpeakers: "",
    defaultFormats: { markdown: true, json: true, docx: false },
    vadEnabled: true,
    defaultSpeedProfile: "balanced",
  };
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
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState(false);

  // Prompt template management
  const promptHook = usePromptTemplates();
  const editableTemplates = promptHook.templates.filter((t) => !t.isCustom);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editTemplate, setEditTemplate] = useState("");
  const [creatingNew, setCreatingNew] = useState(false);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  };

  const handleSave = () => {
    saveSettings(settings);
    setSaved(true);
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
      <h2 className="text-2xl font-bold">Inställningar</h2>

      {/* Default model */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standardmodell</label>
        <select
          value={settings.defaultModel}
          onChange={(e) => update("defaultModel", e.target.value)}
          className="w-full px-3 py-2 rounded-lg glass-input text-sm"
        >
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

      {/* Ollama */}
      <div className="space-y-3 pt-4 border-t border-white/10">
        <h3 className="text-lg font-semibold">Ollama (lokal LLM)</h3>

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
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm transition-all hover:shadow-[0_0_20px_rgba(124,58,237,0.25)]"
        >
          Spara
        </button>
        {saved && <span className="text-sm text-[var(--color-success)]">Sparat!</span>}
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
