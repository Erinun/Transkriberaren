import { useState, useCallback } from "react";
import type { PipelineSummary } from "./usePipeline";

export interface HistoryEntry {
  id: string;
  audioName: string;
  date: string;
  mdContent: string;
  summary: PipelineSummary;
  modelName?: string | null;
  wordCount?: number;
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(loadEntries);

  const addEntry = useCallback(
    (audioName: string, mdContent: string, summary: PipelineSummary) => {
      const entry: HistoryEntry = {
        id: crypto.randomUUID(),
        audioName,
        date: new Date().toISOString(),
        mdContent,
        summary,
      };
      setEntries((prev) => {
        const next = [entry, ...prev].slice(0, MAX_ENTRIES);
        saveEntries(next);
        return next;
      });
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

  return { entries, addEntry, removeEntry };
}
