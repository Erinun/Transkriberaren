import { useState } from "react";
import type { LlmStatus } from "../hooks/useLlm";
import {
  AI_PRESETS,
  formatMeetingHours,
  hostOf,
  maxAnswerWords,
  meetingHoursFor,
  type KnownModel,
} from "../lib/aiProviders";
import CustomSelect from "./CustomSelect";
import { Advanced, HelpLabel, Hint, SettingsSection } from "./SettingsParts";

const errorText = (e: unknown) =>
  typeof e === "string" ? e : (e as { message?: string })?.message ?? "Okänt fel";

const PRICE_STYLE: Record<KnownModel["price"], string> = {
  Låg: "bg-emerald-500/15 text-emerald-300",
  Medel: "bg-yellow-500/15 text-yellow-200",
  Hög: "bg-red-500/15 text-red-300",
};

const sv = (n: number) => n.toLocaleString("sv-SE");

function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
        selected ? "border-[var(--color-primary)] bg-[var(--color-primary)]" : "border-white/30"
      }`}
    />
  );
}

export default function AiProviderSettings({ llm }: { llm: LlmStatus }) {
  const { settings, preset, current } = llm;
  const [keyInput, setKeyInput] = useState("");
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [manualModel, setManualModel] = useState(false);

  const host = current.baseUrl ? hostOf(current.baseUrl) : "";
  const known = preset.knownModels;
  // Modeller som servern listar men som inte finns i vår katalog (t.ex. nya modeller hos Berget).
  const extraModels = llm.models.filter((m) => !known.some((k) => k.id === m.id));
  const selectedKnown = known.find((k) => k.id === current.model);
  const showModelCards = known.length > 0 && !manualModel;
  const showModelList = known.length === 0 && llm.models.length > 0 && !manualModel;

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

  const cardClass = (selected: boolean) =>
    `w-full h-full text-left p-3 rounded-lg border transition-colors ${
      selected ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10" : "border-white/10 hover:bg-white/5"
    }`;

  return (
    <SettingsSection
      title="AI-bearbetning"
      description="Låt en AI-tjänst skriva sammanfattningar och mötesanteckningar utifrån den färdiga texten. Valfritt – transkriberingen fungerar utan."
    >
      <div className="grid lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-8 gap-y-6">
        {/* Vänster kolumn: på/av, leverantör, nyckel, test */}
        <div className="space-y-6">
          <div className="space-y-2">
            <HelpLabel
              label="Använd AI-bearbetning"
              help={
                <>
                  <p>
                    Själva transkriberingen (ljud → text) sker alltid på din dator. AI-bearbetningen är
                    ett extra steg efteråt: den skrivna texten skickas till en AI-tjänst som kan göra om
                    den till t.ex. ett protokoll, en sammanfattning eller en lista med beslut.
                  </p>
                  <p>
                    Ljudet skickas aldrig. Ingenting skickas förrän du själv klickar på <b>Bearbeta</b> i
                    resultatvyn.
                  </p>
                </>
              }
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => llm.setEnabled(e.target.checked)}
                className="accent-[var(--color-primary)]"
              />
              Aktivera AI-bearbetning
            </label>
          </div>

          {settings.enabled && (
            <>
              <div className="p-3 rounded-lg text-xs text-yellow-100 bg-yellow-500/10 border border-yellow-500/20">
                När du bearbetar ett möte skickas transkriptets text
                {host ? <> till <span className="font-medium">{host}</span></> : " till vald server"}.
                Ljudet skickas aldrig. Inget skickas förrän du själv klickar på Bearbeta.
              </div>

              <div className="space-y-2">
                <HelpLabel
                  label="Leverantör"
                  help={
                    <>
                      <p>
                        Leverantören är företaget eller servern som kör AI-modellen. <b>Berget AI</b> är
                        en svensk tjänst där texten behandlas i Sverige.
                      </p>
                      <p>
                        <b>Egen server</b> är för dig som redan har en AI-tjänst som följer OpenAI:s
                        standard, till exempel Ollama installerat på datorn eller en tjänst inom din
                        organisation.
                      </p>
                    </>
                  }
                />
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
                <Hint>{preset.description}</Hint>
              </div>

              {preset.editableUrl && (
                <div className="space-y-2">
                  <HelpLabel
                    label="Server-adress"
                    help={
                      <p>
                        Webbadressen till AI-tjänsten (kallas även API-adress). Den slutar oftast på
                        <b> /v1</b>. Kör du Ollama på den här datorn är adressen
                        <b> http://localhost:11434/v1</b>. Fråga din IT-avdelning om du är osäker.
                      </p>
                    }
                  />
                  <input
                    type="text"
                    value={current.baseUrl}
                    onChange={(e) => llm.updateCurrent({ baseUrl: e.target.value })}
                    placeholder="https://din-server.se/v1"
                    className="w-full px-3 py-2 rounded-lg glass-input text-sm"
                  />
                </div>
              )}

              <div className="space-y-2">
                <HelpLabel
                  label={`API-nyckel${preset.keyRequired ? "" : " (om servern kräver det)"}`}
                  help={
                    <>
                      <p>
                        En API-nyckel är ett lösenord som visar för tjänsten att det är ditt konto som
                        används (och vem som ska betala). Hos Berget AI skapar du den när du är inloggad
                        på berget.ai, under API-nycklar.
                      </p>
                      <p>
                        Nyckeln sparas krypterat i Windows nyckelförvaring och visas aldrig igen i appen.
                        Klistra in den och klicka på <b>Spara</b>.
                      </p>
                    </>
                  }
                />
                <div className="flex gap-2">
                  <input
                    type="password"
                    autoComplete="off"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder={llm.hasKey ? "•••••••• (sparad)" : "Klistra in nyckeln"}
                    className="flex-1 min-w-0 px-3 py-2 rounded-lg glass-input text-sm"
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
                <Hint>
                  {keyMessage ??
                    (llm.hasKey
                      ? "✓ En nyckel är sparad."
                      : preset.keyRequired
                        ? "Ingen nyckel sparad ännu."
                        : "Ingen nyckel sparad.")}
                </Hint>
              </div>

              <div className="space-y-2">
                <HelpLabel
                  label="Kontrollera att allt fungerar"
                  help={
                    <p>
                      Testet skickar en liten förfrågan till leverantören med din nyckel och vald modell,
                      och berättar om anslutningen fungerar. Inget transkript skickas.
                    </p>
                  }
                />
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleTest}
                    disabled={testing || !current.baseUrl}
                    className="px-3 py-1.5 rounded-lg glass hover:bg-white/5 text-xs transition-colors disabled:opacity-50"
                  >
                    {testing ? "Testar..." : "Testa anslutning"}
                  </button>
                  {testResult && (
                    <span className={`text-xs ${testResult.ok ? "text-green-400" : "text-[var(--color-error)]"}`}>
                      {testResult.message}
                    </span>
                  )}
                </div>
              </div>

              <Advanced>
                <div className="space-y-2">
                  <HelpLabel
                    label="Kreativitet (temperatur)"
                    help={
                      <p>
                        Styr hur fritt AI:n formulerar sig. Lågt värde ger sakliga och förutsägbara texter
                        som håller sig nära det som sades – bäst för protokoll. Högt värde ger mer
                        varierat språk men ökar risken att AI:n hittar på. Standard är 0.3.
                      </p>
                    }
                    aside={<span className="text-xs text-[var(--color-text-muted)]">{settings.temperature.toFixed(1)}</span>}
                  />
                  <input
                    type="range"
                    min={0}
                    max={10}
                    step={1}
                    value={settings.temperature * 10}
                    onChange={(e) => llm.setGeneration({ temperature: Number(e.target.value) / 10 })}
                    className="result-range w-full"
                  />
                  <div className="flex justify-between text-[11px] text-[var(--color-text-muted)]">
                    <span>Saklig</span>
                    <span>Kreativ</span>
                  </div>
                </div>
              </Advanced>
            </>
          )}
        </div>

        {/* Höger kolumn: modellval */}
        {settings.enabled ? (
          <div className="space-y-3">
            <HelpLabel
              label="AI-modell"
              help={
                <>
                  <p>
                    Modellen är själva AI:n som läser transkriptet och skriver texten. Olika modeller
                    skiljer sig i kvalitet, hastighet och pris. Är du osäker, välj den som är märkt{" "}
                    <b>Rekommenderas</b>.
                  </p>
                  <p>
                    <b>Varje modell har ett eget tak.</b> Appen sätter ingen egen gräns för svarets längd,
                    men modellen kan bara hålla en viss mängd text i minnet åt gången (kallas
                    kontextfönster). Instruktionen, hela transkriptet och svaret ska rymmas där
                    tillsammans. Dessutom har varje modell en högsta svarslängd.
                  </p>
                  <p>
                    Mängden mäts i <i>tokens</i> – ungefär ordbitar. Som tumregel blir en timmes svenskt
                    möte cirka 15 000 tokens, och 1 000 tokens svar motsvarar runt 650 ord. Siffrorna på
                    korten är uppskattningar.
                  </p>
                </>
              }
              aside={
                <div className="flex gap-3 text-[11px]">
                  <button
                    onClick={() => { setManualModel(false); llm.refreshModels(); }}
                    disabled={llm.loadingModels || !current.baseUrl}
                    className="text-[var(--color-primary)] hover:underline disabled:opacity-50"
                  >
                    {llm.loadingModels ? "Hämtar..." : "Hämta senaste listan"}
                  </button>
                  {(known.length > 0 || llm.models.length > 0) && (
                    <button
                      onClick={() => setManualModel((v) => !v)}
                      className="text-[var(--color-primary)] hover:underline"
                    >
                      {manualModel ? "Välj från lista" : "Skriv modell-ID"}
                    </button>
                  )}
                </div>
              }
            />

            {showModelCards ? (
              <div role="radiogroup" aria-label="AI-modell" className="grid xl:grid-cols-2 gap-2">
                {known.map((m) => {
                  const selected = current.model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => llm.updateCurrent({ model: m.id })}
                      className={cardClass(selected)}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <RadioDot selected={selected} />
                        <span className="text-sm font-medium mr-0.5">{m.name}</span>
                        {m.id === preset.suggestedModel && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--color-primary)]/20 text-[var(--color-primary)]">
                            Rekommenderas
                          </span>
                        )}
                        {m.preview && (
                          <span className="px-1.5 py-0.5 text-[10px] rounded bg-white/10 text-[var(--color-text-muted)]">
                            Förhandsversion
                          </span>
                        )}
                        <span className={`ml-auto px-1.5 py-0.5 text-[10px] rounded ${PRICE_STYLE[m.price]}`}>
                          Pris: {m.price}
                        </span>
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)] mt-1">{m.description}</p>
                      <p
                        className="text-[11px] mt-1.5"
                        title={`Tak: ${sv(m.contextTokens)} tokens totalt, max ${sv(m.maxOutputTokens)} tokens svar`}
                      >
                        <span className="text-[var(--color-text-muted)]">Tak:</span> läser in{" "}
                        {formatMeetingHours(meetingHoursFor(m))} · svar max ca {sv(maxAnswerWords(m.maxOutputTokens))} ord
                      </p>
                    </button>
                  );
                })}
                {extraModels.map((m) => {
                  const selected = current.model === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => llm.updateCurrent({ model: m.id })}
                      className={cardClass(selected)}
                    >
                      <div className="flex items-center gap-2">
                        <RadioDot selected={selected} />
                        <span className="text-sm font-medium break-all">{m.id}</span>
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-white/10 text-[var(--color-text-muted)]">
                          Ny
                        </span>
                      </div>
                      <p className="text-xs text-[var(--color-text-muted)] mt-1.5">
                        Ny modell hos leverantören som appen ännu inte har en beskrivning för.
                        {m.context_length ? ` Tak: ${sv(m.context_length)} tokens totalt.` : ""}
                      </p>
                    </button>
                  );
                })}
              </div>
            ) : showModelList ? (
              <CustomSelect
                value={current.model}
                onChange={(v) => llm.updateCurrent({ model: v })}
                options={[
                  ...(llm.models.some((m) => m.id === current.model) || !current.model
                    ? []
                    : [{ value: current.model, label: `${current.model} (finns inte i listan)` }]),
                  ...llm.models.map((m) => ({
                    value: m.id,
                    label: m.context_length ? `${m.id} (tak ${sv(m.context_length)} tokens)` : m.id,
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
            {showModelCards && current.model && !selectedKnown && !extraModels.some((m) => m.id === current.model) && (
              <Hint>Vald modell: {current.model} (egen inmatning).</Hint>
            )}
            {llm.modelsError && (
              <p className="text-xs text-yellow-200">
                {llm.modelsError} Du kan skriva modell-ID för hand.
              </p>
            )}
            {known.length === 0 && (
              <Hint>
                Klicka på "Hämta senaste listan" för att se vilka modeller servern erbjuder. Varje modell
                har ett eget tak för hur mycket text den klarar – visas i listan om servern uppger det.
              </Hint>
            )}
            {known.length > 0 && (
              <div className="p-3 rounded-lg text-xs bg-white/5 border border-white/10 text-[var(--color-text-muted)]">
                <span className="font-medium text-[var(--color-text)]">Varje modell har ett eget tak.</span>{" "}
                Appen begränsar inte svarets längd, men transkript och svar måste rymmas i modellens tak.
                Klipps svaret av, välj en modell med högre tak. Håll muspekaren över ett tak för exakta
                siffror.
              </div>
            )}
          </div>
        ) : (
          <div className="hidden lg:flex items-center justify-center rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-[var(--color-text-muted)]">
            Aktivera AI-bearbetning för att välja leverantör och AI-modell.
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
