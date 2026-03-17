import { useState, useEffect } from "react";

interface Settings {
  defaultModel: string;
  defaultNumSpeakers: string;
  defaultFormats: { markdown: boolean; json: boolean; docx: boolean };
  vadEnabled: boolean;
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
    <div className="max-w-xl mx-auto space-y-6">
      <h2 className="text-2xl font-bold">Inställningar</h2>

      {/* Default model */}
      <div className="space-y-2">
        <label className="block text-sm text-[var(--color-text-muted)]">Standardmodell</label>
        <select
          value={settings.defaultModel}
          onChange={(e) => update("defaultModel", e.target.value)}
          className="w-full px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-primary)]"
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
          className="w-32 px-3 py-2 rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] text-sm focus:outline-none focus:border-[var(--color-primary)]"
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
          className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm transition-colors"
        >
          Spara
        </button>
        {saved && <span className="text-sm text-[var(--color-success)]">Sparat!</span>}
      </div>
    </div>
  );
}
