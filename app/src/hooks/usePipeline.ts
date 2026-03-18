import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface PipelineSettings {
  model: string;
  numSpeakers: number | null;
  formats: string[];
  outputDir: string;
  vadEnabled: boolean;
  prompt: string | null;
  speedProfile: string;
}

export interface PipelineSummary {
  total_duration: number;
  speech_duration: number;
  processing_time: number;
  num_speakers: number;
  num_segments: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  speaker_id: string | null;
  speaker_label: string | null;
  text: string;
}

type PipelineStatus = "idle" | "running" | "done" | "error";

interface PipelineState {
  status: PipelineStatus;
  stage: string;
  percent: number;
  message: string;
  error: string | null;
  outputFiles: string[];
  summary: PipelineSummary | null;
  mdContent: string | null;
  warnings: string[];
  modelName: string | null;
  segments: TranscriptionSegment[];
  wordCount: number;
}

const INITIAL_STATE: PipelineState = {
  status: "idle",
  stage: "",
  percent: 0,
  message: "",
  error: null,
  outputFiles: [],
  summary: null,
  mdContent: null,
  warnings: [],
  modelName: null,
  segments: [],
  wordCount: 0,
};

export function usePipeline() {
  const [state, setState] = useState<PipelineState>(INITIAL_STATE);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<any>("pipeline-event", (event) => {
      if (cancelled) return;
      const data = event.payload;

      if (data.type === "progress") {
        setState((s) => ({
          ...s,
          stage: data.stage,
          percent: data.percent,
          message: data.message,
        }));
      } else if (data.type === "result") {
        setState((s) => ({
          ...s,
          status: "done",
          percent: 100,
          outputFiles: data.output_files,
          summary: data.summary,
          mdContent: data.md_content ?? null,
          warnings: data.warnings ?? [],
          modelName: data.model_name ?? null,
          segments: data.segments ?? [],
          wordCount: data.word_count ?? 0,
        }));
      } else if (data.type === "error") {
        setState((s) => {
          // Don't overwrite the first (real) error with subsequent generic ones
          if (s.status === "error") return s;
          return {
            ...s,
            status: "error",
            error: data.message,
          };
        });
      }
    }).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });

    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const start = useCallback(
    async (audioPath: string, settings: PipelineSettings) => {
      setState({ ...INITIAL_STATE, status: "running", message: "Startar..." });

      try {
        await invoke("run_transcription", {
          audioPath,
          config: {
            model: settings.model,
            num_speakers: settings.numSpeakers,
            formats: settings.formats,
            output_dir: settings.outputDir,
            vad_enabled: settings.vadEnabled,
            prompt: settings.prompt,
            speed_profile: settings.speedProfile,
          },
        });
      } catch (err: any) {
        setState((s) => {
          // Don't overwrite if we already have a real error from pipeline-event
          if (s.status === "error") return s;
          return {
            ...s,
            status: "error",
            error: typeof err === "string" ? err : err.message ?? "Okänt fel",
          };
        });
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  return { ...state, start, reset };
}
