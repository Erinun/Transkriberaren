import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface OllamaModel {
  name: string;
  size: number;
}

export interface OllamaOptions {
  temperature?: number;
  num_ctx?: number;
  num_predict?: number;
  repeat_penalty?: number;
}

export interface OllamaStatus {
  available: boolean | null;
  models: OllamaModel[];
  selectedModel: string | null;
  selectModel: (name: string) => void;
  refreshModels: () => Promise<void>;
  checkHealth: () => Promise<void>;
  ollamaUrl: string;
  setOllamaUrl: (url: string) => void;
}

interface OllamaEvent {
  request_id: string;
  type: string;
  seq: number;
  token?: string;
  done?: boolean;
  error?: string;
  full_text?: string;
}

const STORAGE_KEY = "motesskribent-ollama-model";
const URL_STORAGE_KEY = "motesskribent-ollama-url";
const DEFAULT_OLLAMA_URL = "http://localhost:11434";

/**
 * Connection-level state: availability, models, selected model.
 * Does NOT run health check automatically - caller must invoke checkHealth().
 */
export function useOllamaStatus(): OllamaStatus {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const [ollamaUrl, setOllamaUrlState] = useState<string>(() => {
    try {
      return localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_OLLAMA_URL;
    } catch {
      return DEFAULT_OLLAMA_URL;
    }
  });

  const setOllamaUrl = useCallback((url: string) => {
    setOllamaUrlState(url);
    localStorage.setItem(URL_STORAGE_KEY, url);
  }, []);

  const selectModel = useCallback((name: string) => {
    setSelectedModelState(name);
    localStorage.setItem(STORAGE_KEY, name);
  }, []);

  const checkHealth = useCallback(async () => {
    const baseUrl = ollamaUrl.trim() || DEFAULT_OLLAMA_URL;
    try {
      const ok = await invoke<boolean>("ollama_check_health", { baseUrl });
      setAvailable(ok);
      if (ok) {
        try {
          const m = await invoke<OllamaModel[]>("ollama_list_models", { baseUrl });
          setModels(m);
          // Auto-select first model if none saved
          if (!localStorage.getItem(STORAGE_KEY) && m.length > 0) {
            setSelectedModelState(m[0].name);
            localStorage.setItem(STORAGE_KEY, m[0].name);
          }
        } catch {}
      }
    } catch {
      setAvailable(false);
    }
  }, [ollamaUrl]);

  const refreshModels = useCallback(async () => {
    await checkHealth();
  }, [checkHealth]);

  return {
    available,
    models,
    selectedModel,
    selectModel,
    refreshModels,
    checkHealth,
    ollamaUrl,
    setOllamaUrl,
  };
}

/**
 * Generation-level hook: takes shared OllamaStatus and adds streaming generation.
 * Returns the same shape as the old useOllama() for backwards compatibility.
 */
export function useOllama(status: OllamaStatus) {
  const [generating, setGenerating] = useState(false);
  const [streamedText, setStreamedText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef<number>(0);
  const textRef = useRef("");
  const rafRef = useRef<number>(0);

  // Listen for streaming events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<OllamaEvent>("ollama-event", (event) => {
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
        setError(data.error ?? "Okant fel");
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
    async (prompt: string, options?: OllamaOptions) => {
      if (!status.selectedModel) {
        setError("Ingen modell vald");
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
        const baseUrl = status.ollamaUrl.trim() || DEFAULT_OLLAMA_URL;
        await invoke("ollama_generate", {
          model: status.selectedModel,
          prompt,
          requestId: rid,
          options: options ?? null,
          baseUrl,
        });
      } catch (err: any) {
        setError(typeof err === "string" ? err : err.message ?? "Okant fel");
        setGenerating(false);
      }
    },
    [status.selectedModel, status.ollamaUrl],
  );

  const resetOutput = useCallback(() => {
    setStreamedText("");
    setError(null);
    requestIdRef.current = null;
  }, []);

  return {
    ...status,
    generating,
    streamedText,
    error,
    generate,
    resetOutput,
  };
}
