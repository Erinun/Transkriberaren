import { invoke } from "@tauri-apps/api/core";

export type EngineId = "pianissimo" | "kb-whisper";

export const DEFAULT_ENGINE: EngineId = "pianissimo";

export const ENGINES: { id: EngineId; label: string; description: string }[] = [
  {
    id: "pianissimo",
    label: "Pianissimo (rekommenderas)",
    description:
      "Klangs svenska taligenkänning. Körs lokalt på datorn och kräver cirka 1,5 GB minne. Endast svenska.",
  },
  {
    id: "kb-whisper",
    label: "KB-Whisper",
    description:
      "KB:s svenska Whisper-modeller. Körs lokalt och används också som reserv om Pianissimo inte kan köras.",
  },
];

export function normalizeEngine(value: unknown): EngineId {
  return ENGINES.some((e) => e.id === value) ? (value as EngineId) : DEFAULT_ENGINE;
}

export function engineLabel(id: string | null | undefined): string {
  if (id === "pianissimo") return "Pianissimo";
  if (id === "kb-whisper") return "KB-Whisper";
  return id ?? "-";
}

/** Berätta för Rust-sidan vilken motor som ska värmas upp vid nästa start. */
export function syncEnginePreference(engine: EngineId): void {
  invoke("set_transcription_engine", { engine }).catch((e) =>
    console.warn("Kunde inte spara motorval:", e),
  );
}
