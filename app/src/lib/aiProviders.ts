/**
 * AI-leverantörer för efterbearbetning (text → text) via OpenAI-kompatibelt API.
 * Inställningarna här är inte hemliga; API-nycklar sparas i Windows
 * nyckelförvaring via Rust och når aldrig webbvyn.
 */

export interface AiPreset {
  id: string;
  name: string;
  baseUrl: string;
  /** Förvalt modellförslag. Utbudet ändras, så användaren kan alltid välja annat. */
  suggestedModel: string;
  keyRequired: boolean;
  editableUrl: boolean;
}

export const AI_PRESETS: AiPreset[] = [
  {
    id: "berget",
    name: "Berget AI",
    baseUrl: "https://api.berget.ai/v1",
    suggestedModel: "google/gemma-4-31B-it",
    keyRequired: true,
    editableUrl: false,
  },
  {
    id: "custom",
    name: "Egen server (OpenAI-kompatibel)",
    baseUrl: "",
    suggestedModel: "",
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
  maxTokens: number;
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
    maxTokens: 4096,
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
    if (typeof opts.num_predict === "number") settings.maxTokens = opts.num_predict;
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
