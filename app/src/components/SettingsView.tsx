import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LlmStatus } from "../hooks/useLlm";
import AiProviderSettings from "./AiProviderSettings";
import PromptTemplateManager from "./PromptTemplateManager";
import CustomSelect from "./CustomSelect";
import { HelpLabel, Hint, SettingsSection } from "./SettingsParts";
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

const TABS = [
  { id: "transcription", label: "Transkribering", desc: "Motor, talare och hastighet" },
  { id: "output", label: "Spara resultat", desc: "Vilka filer som skapas" },
  { id: "meetings", label: "Mötesinspelning", desc: "Påminnelse vid Teams-möten" },
  { id: "ai", label: "AI-bearbetning", desc: "Leverantör, nyckel och modell" },
  { id: "prompts", label: "Promptmallar", desc: "Instruktioner till AI:n" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const TAB_KEY = "motesskribent-settings-tab";

function loadTab(): TabId {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (TABS.some((t) => t.id === saved)) return saved as TabId;
  } catch {}
  return "transcription";
}

export default function SettingsView({ llmStatus }: { llmStatus: LlmStatus }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [tab, setTab] = useState<TabId>(loadTab);

  const selectTab = (id: TabId) => {
    setTab(id);
    try { localStorage.setItem(TAB_KEY, id); } catch {}
  };
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

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
    flashSaved();
  };

  const formats: { key: keyof Settings["defaultFormats"]; label: string; help: string }[] = [
    { key: "markdown", label: "Markdown (.md)", help: "Läsbart textdokument med rubriker. Öppnas i de flesta textprogram." },
    { key: "docx", label: "Word (.docx)", help: "Öppnas i Microsoft Word – bra om protokollet ska delas eller redigeras." },
    { key: "json", label: "JSON (.json)", help: "Strukturerad data med tidsstämplar. För dig som vill bearbeta resultatet i andra program." },
  ];

  return (
    <div className="max-w-6xl mx-auto h-full flex flex-col gap-5 animate-fade-in">
      <div className="shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-2xl font-bold">Inställningar</h2>
          {showSaved && (
            <span className="text-sm text-[var(--color-success)] animate-saved-flash">
              Sparad
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">
          Ändringar sparas direkt. Klicka på{" "}
          <span className="inline-flex w-4 h-4 rounded-full border border-white/30 text-[10px] items-center justify-center align-middle">?</span>{" "}
          bredvid en inställning för att få en förklaring. Standardvärdena fungerar bra för de flesta.
        </p>
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row gap-5">
        <nav aria-label="Inställningskategorier" className="md:w-60 shrink-0 flex md:flex-col gap-1.5 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => selectTab(t.id)}
              aria-current={tab === t.id ? "page" : undefined}
              className={`text-left px-3 py-2.5 rounded-lg transition-colors shrink-0 ${
                tab === t.id
                  ? "bg-[var(--color-primary)]/15 border border-[var(--color-primary)]/40"
                  : "border border-transparent hover:bg-white/5"
              }`}
            >
              <span className={`block text-sm font-medium ${tab === t.id ? "text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                {t.label}
              </span>
              <span className="hidden md:block text-[11px] text-[var(--color-text-muted)]">{t.desc}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0 min-h-0 md:overflow-y-auto">
          {tab === "transcription" && (
          <SettingsSection
            title="Transkribering"
            description="Hur ljudet görs om till text. Allt i det här avsnittet sker på din dator – inget ljud lämnar datorn."
          >
            <div className="grid lg:grid-cols-2 gap-x-8 gap-y-6">
              {/* Transcription engine */}
              <div className="space-y-2">
                <HelpLabel
                  label="Transkriberingsmotor"
                  help={
                    <>
                      <p>
                        Motorn är det program som lyssnar på ljudet och skriver ner vad som sägs. Båda
                        alternativen är tränade på svenska och körs helt lokalt.
                      </p>
                      <p>
                        <b>Pianissimo</b> (från Klang) ger oftast bäst resultat och rekommenderas.{" "}
                        <b>KB-Whisper Base</b> (från Kungliga biblioteket, ~240 MB) är ett alternativ som också
                        används automatiskt som reserv om Pianissimo inte kan starta.
                      </p>
                    </>
                  }
                />
                <CustomSelect
                  value={settings.defaultEngine}
                  onChange={(v) => {
                    const engine = normalizeEngine(v);
                    update("defaultEngine", engine);
                    syncEnginePreference(engine);
                  }}
                  options={ENGINES.map((e) => ({ value: e.id, label: e.label }))}
                />
                <Hint>{ENGINES.find((e) => e.id === settings.defaultEngine)?.description}</Hint>
              </div>

              {/* Default speakers */}
              <div className="space-y-2">
                <HelpLabel
                  label="Antal talare"
                  help={
                    <>
                      <p>
                        Appen försöker känna igen olika röster och märka texten med Talare 1, Talare 2 osv.
                        Lämna fältet tomt (<b>Auto</b>) så räknar appen ut antalet själv.
                      </p>
                      <p>
                        Vet du hur många som deltar blir resultatet ofta bättre om du anger det. Anger du 1
                        hoppar appen över röstigenkänningen, vilket går snabbare.
                      </p>
                      <p>
                        Vid inspelning i appen är du själv alltid Talare 1. Med Auto eller 3 eller fler skiljs
                        de andra deltagarna åt (Talare 2, 3 …). Anger du 2 räknas alla andra som Talare 2.
                      </p>
                    </>
                  }
                />
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={20}
                    placeholder="Auto"
                    value={settings.defaultNumSpeakers}
                    onChange={(e) => update("defaultNumSpeakers", e.target.value)}
                    className="w-32 px-3 py-2 rounded-lg glass-input text-sm"
                  />
                  {settings.defaultNumSpeakers && (
                    <button
                      onClick={() => update("defaultNumSpeakers", "")}
                      className="text-xs text-[var(--color-primary)] hover:underline"
                    >
                      Återställ till Auto
                    </button>
                  )}
                </div>
                <Hint>Tomt = appen avgör själv. Kan ändras för varje enskild transkribering.</Hint>
              </div>

              {/* Speed profile */}
              <div className="space-y-2">
                <HelpLabel
                  label="Hastighet eller noggrannhet"
                  help={
                    <>
                      <p>Ett val mellan hur snabbt transkriberingen går och hur noggrann den blir.</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        <li><b>Snabb</b> – kortast väntetid. Hoppar över ljudanalysen och kan missa fler ord.</li>
                        <li><b>Balanserad</b> – rekommenderas för vanliga möten.</li>
                        <li><b>Hög kvalitet</b> – tar längre tid men prövar fler tolkningar av svåra avsnitt.</li>
                      </ul>
                      <p>Skillnaden märks mest med KB-Whisper.</p>
                    </>
                  }
                />
                <div className="flex rounded-lg overflow-hidden border border-white/10">
                  {([
                    { id: "fast", label: "Snabb" },
                    { id: "balanced", label: "Balanserad" },
                    { id: "quality", label: "Hög kvalitet" },
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
                <div className="space-y-2">
                  <HelpLabel
                    label="Filtrera bort tystnad (VAD)"
                    help={
                      <p>
                        VAD står för <i>Voice Activity Detection</i>, röstaktivitetsdetektering. Funktionen letar
                        upp de delar av ljudet där någon pratar och hoppar över tystnad och bakgrundsljud. Det
                        gör transkriberingen snabbare och minskar risken för påhittade ord i tysta partier.
                        Låt den vara på om du inte har särskilda skäl.
                      </p>
                    }
                  />
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={settings.vadEnabled}
                      onChange={(e) => update("vadEnabled", e.target.checked)}
                      className="accent-[var(--color-primary)]"
                    />
                    Filtrera bort tystnad (rekommenderas)
                  </label>
                </div>
            </div>
          </SettingsSection>
          )}

          {tab === "output" && (
          <SettingsSection
            title="Spara resultat"
            description="Vilka filer som skapas när en transkribering är klar."
          >
            <div className="space-y-2">
              <HelpLabel
                label="Filformat"
                help={
                  <p>
                    Välj ett eller flera format. Samma text sparas i varje valt format. Är du osäker räcker
                    det med <b>Word</b> eller <b>Markdown</b>. Valet kan ändras för varje transkribering.
                  </p>
                }
              />
              <div className="grid md:grid-cols-3 gap-3">
                {formats.map((f) => (
                  <label
                    key={f.key}
                    className={`flex items-start gap-2 text-sm p-3 rounded-lg border cursor-pointer transition-colors ${
                      settings.defaultFormats[f.key]
                        ? "border-[var(--color-primary)]/50 bg-[var(--color-primary)]/10"
                        : "border-white/10 hover:bg-white/5"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={settings.defaultFormats[f.key] ?? false}
                      onChange={(e) =>
                        update("defaultFormats", { ...settings.defaultFormats, [f.key]: e.target.checked })
                      }
                      className="accent-[var(--color-primary)] mt-1"
                    />
                    <span>
                      {f.label}
                      <span className="block text-xs text-[var(--color-text-muted)]">{f.help}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </SettingsSection>
          )}

          {tab === "meetings" && <MeetingDetectionSection />}

          {tab === "ai" && <AiProviderSettings llm={llmStatus} />}

          {tab === "prompts" && (
          <SettingsSection
            title="Promptmallar"
            description="Färdiga instruktioner till AI:n, t.ex. ”Skriv ett protokoll”. De visas som val under ”Bearbeta transkribering” i resultatvyn."
          >
            <PromptTemplateManager />
          </SettingsSection>
          )}
        </div>
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
    <SettingsSection
      title="Mötesinspelning"
      description="Hjälp att komma ihåg att spela in dina Teams-möten."
    >
      <div className="space-y-2">
        <HelpLabel
          label="Upptäck Teams-möten automatiskt"
          help={
            <>
              <p>
                När ett Microsoft Teams-möte startar visar appen en notis som frågar om du vill spela in.
                Inget spelas in förrän du själv tackar ja.
              </p>
              <p>
                För att det ska fungera måste appen vara igång i bakgrunden – stänger du fönstret ligger
                den kvar som en ikon i systemfältet nere till höger.
              </p>
            </>
          }
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => toggle(e.target.checked)}
            className="accent-[var(--color-primary)]"
          />
          Fråga om inspelning när ett Teams-möte startar
        </label>
      </div>
    </SettingsSection>
  );
}
