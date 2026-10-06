import { useState } from "react";
import type { LlmStatus } from "../hooks/useLlm";
import { AI_PRESETS, hostOf } from "../lib/aiProviders";
import CustomSelect from "./CustomSelect";

const errorText = (e: unknown) =>
  typeof e === "string" ? e : (e as { message?: string })?.message ?? "Okänt fel";

export default function AiProviderSettings({ llm }: { llm: LlmStatus }) {
  const { settings, preset, current } = llm;
  const [keyInput, setKeyInput] = useState("");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [manualModel, setManualModel] = useState(false);

  const host = current.baseUrl ? hostOf(current.baseUrl) : "";
  const showModelList = llm.models.length > 0 && !manualModel;

  const handleSaveKey = async () => {
    try {
      await llm.saveKey(keyInput);
      setKeyInput("");
      setKeyMessage("Nyckeln är sparad i Windows nyckelförvaring.");
    } catch (e) {
      setKeyMessage(errorText(e));
    }
  };

  const handleDeleteKey = async () => {
    try {
      await llm.deleteKey();
      setKeyMessage("Nyckeln är borttagen.");
    } catch (e) {
      setKeyMessage(errorText(e));
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await llm.testConnection();
    setTestResult({ ok: res.ok, message: res.message });
    setTesting(false);
  };

  return (
    <div className="space-y-3 pt-4 border-t border-white/10">
      <h3 className="text-lg font-semibold">AI-bearbetning</h3>
      <p className="text-xs text-[var(--color-text-muted)]">
        Gör sammanfattningar och mötesanteckningar av transkriptet med en OpenAI-kompatibel tjänst,
        till exempel Berget AI. Ingen modell behöver laddas ner till datorn.
      </p>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => llm.setEnabled(e.target.checked)}
          className="accent-[var(--color-primary)]"
        />
        Aktivera AI-bearbetning
      </label>

      {settings.enabled && (
        <div className="space-y-3">
          <div className="p-2 rounded-lg text-[11px] text-yellow-100 bg-yellow-500/10 border border-yellow-500/20">
            När du bearbetar ett möte skickas transkriptets text
            {host ? <> till <span className="font-medium">{host}</span></> : " till vald server"}.
            Ljudet skickas aldrig. Inget skickas förrän du själv klickar på Bearbeta.
          </div>

          {/* Provider */}
          <div className="space-y-1">
            <label className="block text-xs text-[var(--color-text-muted)]">Leverantör</label>
            <CustomSelect
              value={preset.id}
              onChange={(v) => {
                llm.setProvider(v);
                setTestResult(null);
                setKeyMessage(null);
                setManualModel(false);
              }}
              options={AI_PRESETS.map((p) => ({ value: p.id, label: p.name }))}
            />
          </div>

          {/* URL */}
          <div className="space-y-1">
            <label className="block text-xs text-[var(--color-text-muted)]">Server-URL</label>
            <input
              type="text"
              value={current.baseUrl}
              readOnly={!preset.editableUrl}
              onChange={(e) => llm.updateCurrent({ baseUrl: e.target.value })}
              placeholder="https://din-server.se/v1"
              className={`w-full px-3 py-2 rounded-lg glass-input text-sm ${preset.editableUrl ? "" : "opacity-70"}`}
            />
            {preset.editableUrl && (
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Adressen till API:t, oftast slutande på /v1. För Ollama på den här datorn: http://localhost:11434/v1
              </p>
            )}
          </div>

          {/* API key */}
          <div className="space-y-1">
            <label className="block text-xs text-[var(--color-text-muted)]">
              API-nyckel{preset.keyRequired ? "" : " (om servern kräver det)"}
            </label>
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="off"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={llm.hasKey ? "•••••••• (sparad)" : "Klistra in nyckeln"}
                className="flex-1 px-3 py-2 rounded-lg glass-input text-sm"
              />
              <button
                onClick={handleSaveKey}
                disabled={!keyInput.trim()}
                className="px-3 py-1 rounded-lg glass hover:bg-white/5 text-xs transition-colors disabled:opacity-50"
              >
                Spara
              </button>
              {llm.hasKey && (
                <button
                  onClick={handleDeleteKey}
                  className="px-3 py-1 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
                >
                  Ta bort
                </button>
              )}
            </div>
            <p className="text-[10px] text-[var(--color-text-muted)]">
              {keyMessage ??
                (llm.hasKey
                  ? "En nyckel är sparad i Windows nyckelförvaring."
                  : preset.keyRequired
                    ? "Ingen nyckel sparad. Nyckeln sparas i Windows nyckelförvaring, inte i klartext."
                    : "Ingen nyckel sparad.")}
            </p>
          </div>

          {/* Model */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="block text-xs text-[var(--color-text-muted)]">Modell</label>
              <div className="flex gap-3 text-[10px]">
                <button
                  onClick={() => { setManualModel(false); llm.refreshModels(); }}
                  disabled={llm.loadingModels || !current.baseUrl}
                  className="text-[var(--color-primary)] hover:underline disabled:opacity-50"
                >
                  {llm.loadingModels ? "Hämtar..." : "Hämta modellista"}
                </button>
                {llm.models.length > 0 && (
                  <button
                    onClick={() => setManualModel((v) => !v)}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {manualModel ? "Välj från lista" : "Skriv modell-ID"}
                  </button>
                )}
              </div>
            </div>
            {showModelList ? (
              <CustomSelect
                value={current.model}
                onChange={(v) => llm.updateCurrent({ model: v })}
                options={[
                  ...(llm.models.some((m) => m.id === current.model) || !current.model
                    ? []
                    : [{ value: current.model, label: `${current.model} (finns inte i listan)` }]),
                  ...llm.models.map((m) => ({
                    value: m.id,
                    label: m.context_length
                      ? `${m.id} (${m.context_length.toLocaleString("sv-SE")} tokens)`
                      : m.id,
                  })),
                ]}
              />
            ) : (
              <input
                type="text"
                value={current.model}
                onChange={(e) => llm.updateCurrent({ model: e.target.value })}
                placeholder={preset.suggestedModel || "modell-id"}
                className="w-full px-3 py-2 rounded-lg glass-input text-sm"
              />
            )}
            {llm.modelsError && (
              <p className="text-[10px] text-yellow-200">
                {llm.modelsError} Du kan skriva modell-ID för hand.
              </p>
            )}
            {preset.suggestedModel && (
              <p className="text-[10px] text-[var(--color-text-muted)]">
                Förslag: {preset.suggestedModel}. Utbudet hos leverantören ändras över tid.
              </p>
            )}
          </div>

          {/* Test */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testing || !current.baseUrl}
              className="px-3 py-1 rounded-lg glass hover:bg-white/5 text-xs transition-colors disabled:opacity-50"
            >
              {testing ? "Testar..." : "Testa anslutning"}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? "text-green-400" : "text-[var(--color-error)]"}`}>
                {testResult.message}
              </span>
            )}
          </div>

          {/* Generation parameters */}
          <div className="space-y-3 pt-2">
            <p className="text-sm text-[var(--color-text-muted)] font-medium">Genereringsparametrar</p>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-[var(--color-text-muted)]">Temperatur</label>
                <span className="text-xs text-[var(--color-text-muted)]">{settings.temperature.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={settings.temperature * 10}
                onChange={(e) => llm.setGeneration({ temperature: Number(e.target.value) / 10 })}
                className="result-range w-full"
              />
              <p className="text-[10px] text-[var(--color-text-muted)] mt-0.5">
                Lägre = mer fokuserad, högre = mer kreativ. Standard: 0.3
              </p>
            </div>
            <div>
              <label className="text-xs text-[var(--color-text-muted)] block mb-1">Max längd på svaret (tokens)</label>
              <CustomSelect
                value={String(settings.maxTokens)}
                onChange={(v) => llm.setGeneration({ maxTokens: Number(v) })}
                options={[1024, 2048, 4096, 8192, 16384].map((n) => ({
                  value: String(n),
                  label: n === 4096 ? "4 096 (standard)" : n.toLocaleString("sv-SE"),
                }))}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
