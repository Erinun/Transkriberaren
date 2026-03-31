import { useState, useCallback } from "react";
import type { PipelineSummary } from "./usePipeline";

export interface OllamaResult {
  templateId: string;
  templateName: string;
  ollamaModel: string;
  content: string;
  generatedAt: string;
}

export interface HistoryEntry {
  id: string;
  audioName: string;
  date: string;
  mdContent: string;
  summary: PipelineSummary;
  modelName?: string | null;
  wordCount?: number;
  ollamaResults?: OllamaResult[];
}

const STORAGE_KEY = "motesskribent-history";
const MAX_ENTRIES = 5;

function loadEntries(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

function saveEntries(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch (e: any) {
    // QuotaExceededError — trim ollamaResults from oldest entries and retry
    if (e?.name === "QuotaExceededError" || e?.code === 22) {
      const trimmed = entries.map((entry, i) => {
        // Keep newest entry's results, trim older ones
        if (i > 0 && entry.ollamaResults?.length) {
          return { ...entry, ollamaResults: [] };
        }
        return entry;
      });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
      } catch {
        // Last resort: save without any ollamaResults
        const bare = entries.map(({ ollamaResults, ...rest }) => rest);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(bare));
      }
    }
  }
}

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(loadEntries);

  const addEntry = useCallback(
    (audioName: string, mdContent: string, summary: PipelineSummary, modelName?: string | null, wordCount?: number): string => {
      const id = crypto.randomUUID();
      const entry: HistoryEntry = {
        id,
        audioName,
        date: new Date().toISOString(),
        mdContent,
        summary,
        modelName,
        wordCount,
      };
      setEntries((prev) => {
        const next = [entry, ...prev].slice(0, MAX_ENTRIES);
        saveEntries(next);
        return next;
      });
      return id;
    },
    [],
  );

  const removeEntry = useCallback((id: string) => {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveEntries(next);
      return next;
    });
  }, []);

  const saveOllamaResult = useCallback((entryId: string, result: OllamaResult) => {
    setEntries((prev) => {
      const next = prev.map((entry) => {
        if (entry.id !== entryId) return entry;
        const existing = entry.ollamaResults ?? [];
        // Upsert: replace if same templateId exists, otherwise append
        const idx = existing.findIndex((r) => r.templateId === result.templateId);
        const updated = idx >= 0
          ? existing.map((r, i) => (i === idx ? result : r))
          : [...existing, result];
        return { ...entry, ollamaResults: updated };
      });
      saveEntries(next);
      return next;
    });
  }, []);

  return { entries, addEntry, removeEntry, saveOllamaResult };
}
