import { useState, useCallback, useMemo } from "react";
import { PROMPT_TEMPLATES, type PromptTemplate } from "../data/promptTemplates";

const STORAGE_KEY = "motesskribent-prompt-templates";

interface StoredPromptData {
  overrides: Record<string, Partial<Pick<PromptTemplate, "name" | "description" | "template">>>;
  userTemplates: PromptTemplate[];
}

function loadStored(): StoredPromptData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { overrides: {}, userTemplates: [] };
}

function saveStored(data: StoredPromptData) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function generateId(): string {
  return "user-" + crypto.randomUUID();
}

export function usePromptTemplates() {
  const [stored, setStored] = useState<StoredPromptData>(loadStored);

  const persist = useCallback((next: StoredPromptData) => {
    setStored(next);
    saveStored(next);
  }, []);

  const templates = useMemo<PromptTemplate[]>(() => {
    const builtIn = PROMPT_TEMPLATES.filter((t) => !t.isCustom).map((t) => {
      const override = stored.overrides[t.id];
      if (!override) return t;
      return { ...t, ...override };
    });
    const customEntry = PROMPT_TEMPLATES.find((t) => t.isCustom);
    return [...builtIn, ...stored.userTemplates, ...(customEntry ? [customEntry] : [])];
  }, [stored]);

  const updateBuiltIn = useCallback(
    (id: string, changes: Partial<Pick<PromptTemplate, "name" | "description" | "template">>) => {
      persist({
        ...stored,
        overrides: {
          ...stored.overrides,
          [id]: { ...(stored.overrides[id] ?? {}), ...changes },
        },
      });
    },
    [stored, persist],
  );

  const resetBuiltIn = useCallback(
    (id: string) => {
      const { [id]: _, ...rest } = stored.overrides;
      persist({ ...stored, overrides: rest });
    },
    [stored, persist],
  );

  const isOverridden = useCallback(
    (id: string) => id in stored.overrides,
    [stored],
  );

  const createTemplate = useCallback(
    (template: Omit<PromptTemplate, "id">) => {
      const newTemplate: PromptTemplate = { ...template, id: generateId() };
      persist({
        ...stored,
        userTemplates: [...stored.userTemplates, newTemplate],
      });
    },
    [stored, persist],
  );

  const updateUserTemplate = useCallback(
    (id: string, changes: Partial<Pick<PromptTemplate, "name" | "description" | "template">>) => {
      persist({
        ...stored,
        userTemplates: stored.userTemplates.map((t) =>
          t.id === id ? { ...t, ...changes } : t,
        ),
      });
    },
    [stored, persist],
  );

  const deleteTemplate = useCallback(
    (id: string) => {
      persist({
        ...stored,
        userTemplates: stored.userTemplates.filter((t) => t.id !== id),
      });
    },
    [stored, persist],
  );

  const isUserTemplate = useCallback(
    (id: string) => stored.userTemplates.some((t) => t.id === id),
    [stored],
  );

  return {
    templates,
    updateBuiltIn,
    resetBuiltIn,
    isOverridden,
    createTemplate,
    updateUserTemplate,
    deleteTemplate,
    isUserTemplate,
  };
}
