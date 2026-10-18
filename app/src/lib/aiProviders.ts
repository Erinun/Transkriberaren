/**
 * AI-leverantörer för efterbearbetning (text → text) via OpenAI-kompatibelt API.
 * Inställningarna här är inte hemliga; API-nycklar sparas i Windows
 * nyckelförvaring via Rust och når aldrig webbvyn.
 */

/** En känd chattmodell med en kort förklaring för användare som inte kan modellnamnen. */
export interface KnownModel {
  id: string;
  name: string;
  description: string;
  /** Ungefärlig kostnad jämfört med de andra modellerna hos samma leverantör. */
  price: "Låg" | "Medel" | "Hög";
  /** Kontextfönster: hur mycket text (fråga + transkript + svar) modellen kan hantera, i tokens. */
  contextTokens: number;
  /** Längsta svar modellen kan skriva, i tokens. */
  maxOutputTokens: number;
  preview?: boolean;
}

/**
 * Tumregler för att översätta tokens till något begripligt. Svenskt tal är
 * runt 130 ord i minuten och ett svenskt ord blir cirka två tokens, så en
 * timmes möte blir ungefär 15 000 tokens transkript.
 */
const TOKENS_PER_MEETING_HOUR = 15_000;
const WORDS_PER_TOKEN = 0.65;
/** Utrymme för promptmallens instruktion. */
const PROMPT_RESERVE_TOKENS = 1_000;

/** Ungefär hur många timmars möte modellen orkar läsa in och ändå hinna svara. */
export function meetingHoursFor(m: Pick<KnownModel, "contextTokens" | "maxOutputTokens">): number {
  const answer = Math.min(m.maxOutputTokens, m.contextTokens / 4);
  return (m.contextTokens - answer - PROMPT_RESERVE_TOKENS) / TOKENS_PER_MEETING_HOUR;
}

export function formatMeetingHours(hours: number): string {
  if (hours >= 24) return "över 24 timmars möte";
  if (hours >= 2) return `ca ${Math.floor(hours)} timmars möte`;
  const half = Math.max(0.5, Math.floor(hours * 2) / 2);
  return `ca ${half.toLocaleString("sv-SE")} timmes möte`;
}

/** Ungefärligt max antal ord i svaret, avrundat till hundratal. */
export function maxAnswerWords(maxOutputTokens: number): number {
  return Math.round((maxOutputTokens * WORDS_PER_TOKEN) / 100) * 100;
}

export interface AiPreset {
  id: string;
  name: string;
  /** Kort förklaring som visas under leverantörsvalet. */
  description: string;
  baseUrl: string;
  /** Förvalt modellförslag. Utbudet ändras, så användaren kan alltid välja annat. */
  suggestedModel: string;
  /** Chattmodeller som visas direkt, utan att modellistan behöver hämtas. */
  knownModels: KnownModel[];
  keyRequired: boolean;
  editableUrl: boolean;
}

/**
 * Bergets chattmodeller (model_type "text") enligt api.berget.ai/v1/models, oktober 2026.
 * Tak (kontext och max svar) från api.berget.ai/v1/openrouter/models.
 */
export const BERGET_CHAT_MODELS: KnownModel[] = [
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B",
    description:
      "Googles allroundmodell. Bra svenska, snabb och billig – ett tryggt val för sammanfattningar och protokoll.",
    price: "Låg",
    contextTokens: 262_144,
    maxOutputTokens: 4_096,
  },
  {
    id: "mistralai/Mistral-Small-3.2-24B-Instruct-2506",
    name: "Mistral Small 3.2 24B",
    description:
      "Europeisk modell från franska Mistral. Stabil och förutsägbar, passar korta möten och enkla sammanfattningar.",
    price: "Låg",
    contextTokens: 32_768,
    maxOutputTokens: 32_768,
  },
  {
    id: "zai-org/GLM-5.3-Flash",
    name: "GLM 5.3 Flash",
    description:
      "Stor modell som är byggd för fart. Bra när mötet är långt och du vill ha svaret snabbt.",
    price: "Låg",
    contextTokens: 1_048_576,
    maxOutputTokens: 32_768,
  },
  {
    id: "Qwen/Qwen3.8-27B-FP8",
    name: "Qwen 3.8 27B",
    description:
      "Duktig på att följa instruktioner och skapa tydlig struktur, t.ex. beslutslistor. Förhandsversion som kan ändras.",
    price: "Medel",
    contextTokens: 262_144,
    maxOutputTokens: 8_192,
    preview: true,
  },
  {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    description:
      "Bergets största och mest kapabla modell. Ger de mest genomarbetade texterna men är långsammare och klart dyrast.",
    price: "Hög",
    contextTokens: 327_680,
    maxOutputTokens: 16_384,
  },
];

export const AI_PRESETS: AiPreset[] = [
  {
    id: "berget",
    name: "Berget AI",
    description:
      "Svensk AI-tjänst med servrar i Sverige. Kräver ett konto och en API-nyckel från berget.ai.",
    baseUrl: "https://api.berget.ai/v1",
    suggestedModel: "google/gemma-4-31B-it",
    knownModels: BERGET_CHAT_MODELS,
    keyRequired: true,
    editableUrl: false,
  },
  {
    id: "custom",
    name: "Egen server (OpenAI-kompatibel)",
    description:
      "För dig som har en egen AI-server, t.ex. Ollama på datorn eller organisationens interna tjänst.",
    baseUrl: "",
    suggestedModel: "",
    knownModels: [],
    keyRequired: false,
    editableUrl: true,
  },
];

export interface ProviderSettings {
  baseUrl: string;
  model: string;
}

export interface AiSettings {
  /** Avstängt tills användaren själv aktiverar och väljer leverantör. */
  enabled: boolean;
  providerId: string;
  providers: Record<string, ProviderSettings>;
  temperature: number;
}

const STORAGE_KEY = "motesskribent-ai-settings";
const OLD_OLLAMA_URL = "motesskribent-ollama-url";
const OLD_OLLAMA_MODEL = "motesskribent-ollama-model";
const OLD_OLLAMA_OPTIONS = "motesskribent-ollama-options";

export function defaultAiSettings(): AiSettings {
  return {
    enabled: false,
    providerId: "berget",
    providers: Object.fromEntries(
      AI_PRESETS.map((p) => [p.id, { baseUrl: p.baseUrl, model: p.suggestedModel }]),
    ),
    temperature: 0.3,
  };
}

export function presetFor(id: string): AiPreset {
  return AI_PRESETS.find((p) => p.id === id) ?? AI_PRESETS[0];
}

/** Gamla Ollama-inställningar blir en avstängd "Egen server" mot Ollamas /v1-API. */
function migrateFromOllama(settings: AiSettings): AiSettings {
  const url = localStorage.getItem(OLD_OLLAMA_URL);
  const model = localStorage.getItem(OLD_OLLAMA_MODEL);
  if (!url && !model) return settings;
  const base = (url || "http://localhost:11434").trim().replace(/\/+$/, "");
  settings.providerId = "custom";
  settings.providers.custom = {
    baseUrl: base.endsWith("/v1") ? base : `${base}/v1`,
    model: model ?? "",
  };
  try {
    const opts = JSON.parse(localStorage.getItem(OLD_OLLAMA_OPTIONS) ?? "{}");
    if (typeof opts.temperature === "number") settings.temperature = opts.temperature;
  } catch {}
  return settings;
}

export function loadAiSettings(): AiSettings {
  const defaults = defaultAiSettings();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...defaults,
        ...parsed,
        providers: { ...defaults.providers, ...(parsed.providers ?? {}) },
      };
    }
    const migrated = migrateFromOllama(defaults);
    saveAiSettings(migrated);
    return migrated;
  } catch {
    return defaults;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {}
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Gemensam systeminstruktion för all AI-bearbetning. */
export const SWEDISH_SYSTEM_PROMPT =
  "Du är en noggrann mötessekreterare. Svara alltid på svenska. " +
  "Bygg bara på det som faktiskt sägs i transkriptet och hitta inte på namn, datum eller beslut.";
