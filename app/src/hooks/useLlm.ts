import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  loadAiSettings,
  presetFor,
  saveAiSettings,
  SWEDISH_SYSTEM_PROMPT,
  type AiPreset,
  type AiSettings,
  type ProviderSettings,
} from "../lib/aiProviders";

export interface LlmModel {
  id: string;
  context_length: number | null;
}

export interface ConnectionTest {
  ok: boolean;
  message: string;
  models: LlmModel[];
}

export interface LlmStatus {
  settings: AiSettings;
  preset: AiPreset;
  current: ProviderSettings;
  /** Aktiverad, med URL, modell och (om det krävs) nyckel. */
  isReady: boolean;
  hasKey: boolean | null;
  models: LlmModel[];
  modelsError: string | null;
  loadingModels: boolean;
  setEnabled: (enabled: boolean) => void;
  setProvider: (id: string) => void;
  updateCurrent: (changes: Partial<ProviderSettings>) => void;
  setGeneration: (changes: Partial<Pick<AiSettings, "temperature" | "maxTokens">>) => void;
  saveKey: (key: string) => Promise<void>;
  deleteKey: () => Promise<void>;
  refreshModels: () => Promise<void>;
  testConnection: () => Promise<ConnectionTest>;
}

interface LlmEvent {
  request_id: string;
  type: "token" | "done" | "error";
  seq: number;
  token?: string;
  error?: string;
  full_text?: string;
}

const errorText = (e: unknown) =>
  typeof e === "string" ? e : (e as { message?: string })?.message ?? "Okänt fel";

/** Inställningar och anslutning för vald AI-leverantör. Gör inga nätverksanrop av sig själv. */
export function useLlmStatus(): LlmStatus {
  const [settings, setSettings] = useState<AiSettings>(loadAiSettings);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [models, setModels] = useState<LlmModel[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  const preset = presetFor(settings.providerId);
  const current = settings.providers[preset.id] ?? { baseUrl: preset.baseUrl, model: preset.suggestedModel };

  const persist = useCallback((fn: (s: AiSettings) => AiSettings) => {
    setSettings((prev) => {
      const next = fn(prev);
      saveAiSettings(next);
      return next;
    });
  }, []);

  // Nyckelstatus läses lokalt ur nyckelförvaringen (inget nätverk).
  useEffect(() => {
    let cancelled = false;
    setHasKey(null);
    setModels([]);
    setModelsError(null);
    invoke<boolean>("llm_has_api_key", { providerId: preset.id })
      .then((v) => { if (!cancelled) setHasKey(v); })
      .catch(() => { if (!cancelled) setHasKey(false); });
    return () => { cancelled = true; };
  }, [preset.id]);

  const setEnabled = useCallback((enabled: boolean) => persist((s) => ({ ...s, enabled })), [persist]);
  const setProvider = useCallback((id: string) => persist((s) => ({ ...s, providerId: id })), [persist]);
  const updateCurrent = useCallback(
    (changes: Partial<ProviderSettings>) =>
      persist((s) => {
        const p = presetFor(s.providerId);
        const prev = s.providers[p.id] ?? { baseUrl: p.baseUrl, model: p.suggestedModel };
        return { ...s, providers: { ...s.providers, [p.id]: { ...prev, ...changes } } };
      }),
    [persist],
  );
  const setGeneration = useCallback(
    (changes: Partial<Pick<AiSettings, "temperature" | "maxTokens">>) => persist((s) => ({ ...s, ...changes })),
    [persist],
  );

  const saveKey = useCallback(async (key: string) => {
    await invoke("llm_set_api_key", { providerId: preset.id, apiKey: key });
    setHasKey(key.trim().length > 0);
  }, [preset.id]);

  const deleteKey = useCallback(async () => {
    await invoke("llm_delete_api_key", { providerId: preset.id });
    setHasKey(false);
  }, [preset.id]);

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    setModelsError(null);
    try {
      const m = await invoke<LlmModel[]>("llm_list_models", { providerId: preset.id, baseUrl: current.baseUrl });
      setModels(m);
    } catch (e) {
      setModels([]);
      setModelsError(errorText(e));
    } finally {
      setLoadingModels(false);
    }
  }, [preset.id, current.baseUrl]);

  const testConnection = useCallback(async (): Promise<ConnectionTest> => {
    try {
      const res = await invoke<ConnectionTest>("llm_test_connection", {
        providerId: preset.id,
        baseUrl: current.baseUrl,
        model: current.model || null,
      });
      if (res.models.length > 0) {
        setModels(res.models);
        setModelsError(null);
      }
      return res;
    } catch (e) {
      return { ok: false, message: errorText(e), models: [] };
    }
  }, [preset.id, current.baseUrl, current.model]);

  const isReady =
    settings.enabled &&
    current.baseUrl.trim().length > 0 &&
    current.model.trim().length > 0 &&
    (!preset.keyRequired || hasKey === true);

  return {
    settings, preset, current, isReady, hasKey, models, modelsError, loadingModels,
    setEnabled, setProvider, updateCurrent, setGeneration, saveKey, deleteKey, refreshModels, testConnection,
  };
}

/** Strömmande generering mot vald leverantör. */
export function useLlm(status: LlmStatus) {
  const [generating, setGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const textRef = useRef("");
  const rafRef = useRef(0);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<LlmEvent>("llm-event", (event) => {
      if (cancelled) return;
      const data = event.payload;
      if (data.request_id !== requestIdRef.current) return;
      if (data.seq <= lastSeqRef.current) return;
      lastSeqRef.current = data.seq;

      if (data.type === "token" && data.token) {
        textRef.current += data.token;
        if (!rafRef.current) {
          rafRef.current = requestAnimationFrame(() => {
            setStreamedText(textRef.current);
            rafRef.current = 0;
          });
        }
      } else if (data.type === "done") {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        if (data.full_text) {
          textRef.current = data.full_text;
          setStreamedText(data.full_text);
        }
        setGenerating(false);
      } else if (data.type === "error") {
        setError(data.error ?? "Okänt fel");
        setGenerating(false);
      }
    }).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, []);

  const generate = useCallback(
    async (prompt: string, system: string = SWEDISH_SYSTEM_PROMPT) => {
      if (!status.isReady) {
        setError("AI-bearbetning är inte konfigurerad. Välj leverantör och modell under Inställningar.");
        return;
      }
      const rid = crypto.randomUUID();
      requestIdRef.current = rid;
      lastSeqRef.current = 0;
      textRef.current = "";
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      setStreamedText("");
      setError(null);
      setGenerating(true);

      try {
        await invoke("llm_generate", {
          requestId: rid,
          providerId: status.preset.id,
          baseUrl: status.current.baseUrl,
          model: status.current.model,
          system,
          prompt,
          options: { temperature: status.settings.temperature, max_tokens: status.settings.maxTokens },
        });
      } catch (err) {
        // Felet har normalt redan kommit som llm-event; sätt det om inte.
        setError((prev) => prev ?? errorText(err));
        setGenerating(false);
      }
    },
    [status.isReady, status.preset.id, status.current.baseUrl, status.current.model,
     status.settings.temperature, status.settings.maxTokens],
  );

  const cancel = useCallback(async () => {
    if (requestIdRef.current && generating) {
      try {
        await invoke("llm_cancel", { requestId: requestIdRef.current });
      } catch {}
      setGenerating(false);
    }
  }, [generating]);

  const resetOutput = useCallback(() => {
    setStreamedText("");
    setError(null);
    requestIdRef.current = null;
  }, []);

  return { ...status, generating, streamedText, error, generate, cancel, resetOutput };
}
