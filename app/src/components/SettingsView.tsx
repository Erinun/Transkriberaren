import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LlmStatus } from "../hooks/useLlm";
import AiProviderSettings from "./AiProviderSettings";
import { usePromptTemplates } from "../hooks/usePromptTemplates";
import { PROMPT_TEMPLATES } from "../data/promptTemplates";
import CustomSelect from "./CustomSelect";
import { DEFAULT_ENGINE, ENGINES, normalizeEngine, syncEnginePreference, type EngineId } from "../lib/engines";

interface Settings {
  defaultEngine: EngineId;
  defaultModel: string;
  defaultNumSpeakers: string;
  defaultFormats: { markdown: boolean; json: boolean; docx: boolean };
  vadEnabled: boolean;
  defaultSpeedProfile: string;
}

const STORAGE_KEY = "motesskribent-settings";

function loadSettings(): Settings {
  const defaults: Settings = {
    defaultEngine: DEFAULT_ENGINE,
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
      // Migrera ogiltiga modeller → base
      // Sedan 0.7.1 ingår bara Base (Tiny/Small togs bort för att hålla installern under 2 GB)
      const validModels = ["KBLab/kb-whisper-base"];
      if (parsed.defaultModel && !validModels.includes(parsed.defaultModel)) {
        parsed.defaultModel = "KBLab/kb-whisper-base";
        localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
      }
      return {
        ...defaults,
        ...parsed,
        defaultEngine: normalizeEngine(parsed.defaultEngine),
        defaultFormats: { ...defaults.defaultFormats, ...parsed.defaultFormats },
      };
    }
  } catch {}
  return defaults;
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export default function SettingsView({ llmStatus }: { llmStatus: LlmStatus }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

      {/* Transcription engine */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Transkriberingsmotor</label>
        <CustomSelect
          value={settings.defaultEngine}
          onChange={(v) => {
            const engine = normalizeEngine(v);
            update("defaultEngine", engine);
            syncEnginePreference(engine);
          }}
          options={ENGINES.map((e) => ({ value: e.id, label: e.label }))}
        />
        <p className="text-xs text-[var(--color-text-muted)]">
          {ENGINES.find((e) => e.id === settings.defaultEngine)?.description}
          {" "}Ljudet bearbetas alltid lokalt på datorn.
        </p>
      </div>

      {/* KB-Whisper (alternativ motor och reserv) */}
      <div className="space-y-1">
        <label className="block text-sm text-[var(--color-text-muted)]">KB-Whisper</label>
        <p className="text-xs text-[var(--color-text-muted)]">
          KB-Whisper Base (~240 MB) ingår och används{" "}
          {settings.defaultEngine === "kb-whisper" ? "som transkriberingsmotor" : "som reserv om Pianissimo inte kan köras"}.
        </p>
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
        <p className="text-xs text-[var(--color-text-muted)]">
          Vid inspelning är du alltid Talare 1. Med Auto eller 3+ skiljs fjärrdeltagarna åt (Talare 2, 3 …).
          Anger du 1 eller 2 räknas alla fjärrdeltagare som Talare 2.
        </p>
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

      {/* AI-bearbetning */}
      <AiProviderSettings llm={llmStatus} />

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
                      <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">
                        {isUser ? "Instruktion" : "Promptmall"}
                      </label>
                      <textarea
                        value={editTemplate}
                        onChange={(e) => setEditTemplate(e.target.value)}
                        rows={6}
                        className="w-full px-2 py-1.5 rounded-lg glass-input text-sm resize-none font-mono"
                      />
                      <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                        {isUser
                          ? "Transkriberingen läggs till automatiskt. Extra kontext kan läggas till i resultatvyn."
                          : <>Transkriberingen läggs till automatiskt. Använd {"{transcription}"} och {"{context}"} som platshållare för att styra placeringen.</>
                        }
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
              <label className="text-[11px] text-[var(--color-text-muted)] block mb-0.5">Instruktion</label>
              <textarea
                value={editTemplate}
                onChange={(e) => setEditTemplate(e.target.value)}
                placeholder="Beskriv vad du vill att AI:n ska göra med transkriberingen, t.ex. 'Sammanfatta mötets viktigaste punkter och lista alla beslut'"
                rows={6}
                className="w-full px-2 py-1.5 rounded-lg glass-input text-sm resize-none font-mono"
              />
              <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                Transkriberingen läggs till automatiskt. Extra kontext kan läggas till i resultatvyn.
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
