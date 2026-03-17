import { useState } from "react";

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

export default function SettingsView() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [saved, setSaved] = useState(false);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => ({ ...s, [key]: value }));
    setSaved(false);
  };

  const handleSave = () => {
    saveSettings(settings);
    setSaved(true);
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

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm transition-all hover:shadow-[0_0_20px_rgba(124,58,237,0.25)]"
        >
          Spara
        </button>
        {saved && <span className="text-sm text-[var(--color-success)]">Sparat!</span>}
      </div>
    </div>
  );
}
