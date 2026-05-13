import { useState, useEffect, useCallback, useRef } from "react";
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
  audioSource: string | null;
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

export interface EventLogEntry {
  time: number;
  message: string;
}

interface PipelineState {
  status: PipelineStatus;
  stage: string;
  percent: number;
  message: string;
  isIndeterminate: boolean;
  error: string | null;
  outputFiles: string[];
  summary: PipelineSummary | null;
  mdContent: string | null;
  warnings: string[];
  modelName: string | null;
  segments: TranscriptionSegment[];
  wordCount: number;
  lastEventTime: number;
  startTime: number;
  eventLog: EventLogEntry[];
}

const INITIAL_STATE: PipelineState = {
  status: "idle",
  stage: "",
  percent: 0,
  message: "",
  isIndeterminate: false,
  error: null,
  outputFiles: [],
  summary: null,
  mdContent: null,
  warnings: [],
  modelName: null,
  segments: [],
  wordCount: 0,
  lastEventTime: 0,
  startTime: 0,
  eventLog: [],
};

const HEARTBEAT_TIMEOUT_MS = 60_000; // 60 seconds without any event = stale (supports long files)
const HEARTBEAT_CHECK_INTERVAL_MS = 15_000; // check every 15 seconds

export function usePipeline() {
  const [state, setState] = useState<PipelineState>(INITIAL_STATE);
  const lastEventTimeRef = useRef(0);

  // Heartbeat watchdog: log stale pipeline (no events for 60s)
  // NOTE: Does NOT set status to "error" — ProcessingView already shows a
  // stale-warning banner when sinceLast > 60. Setting "error" caused the view
  // to navigate away while the Python pipeline was still running, making it
  // look like the transcription failed even though it completed later.
  useEffect(() => {
    const interval = setInterval(() => {
      const lastEvent = lastEventTimeRef.current;
      if (lastEvent === 0) return; // not running

      setState((s) => {
        if (s.status !== "running") return s;
        const elapsed = Date.now() - lastEvent;
        if (elapsed > HEARTBEAT_TIMEOUT_MS) {
          console.warn("[usePipeline] WATCHDOG: stale pipeline", {
            elapsed,
            lastEvent,
            now: Date.now(),
            currentStage: s.stage,
            currentPercent: s.percent,
          });
        }
        return s;
      });
    }, HEARTBEAT_CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<any>("pipeline-event", (event) => {
      if (cancelled) return;
      const data = event.payload;

      if (data.type === "progress") {
        setState((s) => {
          const now = Date.now();
          lastEventTimeRef.current = now;
          const logEntry: EventLogEntry = { time: now, message: data.message };
          const newLog = [...s.eventLog.slice(-4), logEntry];

          // Heartbeat: update liveness only, don't change displayed stage/percent
          if (data.stage === "heartbeat") {
            return { ...s, lastEventTime: now, eventLog: newLog };
          }

          if (data.percent === -1) {
            return {
              ...s,
              stage: data.stage,
              message: data.message,
              isIndeterminate: true,
              lastEventTime: now,
              eventLog: newLog,
            };
          }
          return {
            ...s,
            stage: data.stage,
            percent: data.percent,
            message: data.message,
            isIndeterminate: false,
            lastEventTime: now,
            eventLog: newLog,
          };
        });
      } else if (data.type === "result") {
        console.log("[DIAG] pipeline result event received");
        lastEventTimeRef.current = 0; // stop watchdog
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
        console.log("[DIAG] pipeline error event:", data.message);
        console.warn("[usePipeline] ERROR EVENT received", { data });
        lastEventTimeRef.current = 0; // stop watchdog
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
      const now = Date.now();
      lastEventTimeRef.current = now;
      setState({ ...INITIAL_STATE, status: "running", message: "Startar...", startTime: now, lastEventTime: now });

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
            audio_source: settings.audioSource,
          },
        });
      } catch (err: any) {
        console.log("[DIAG] invoke rejected:", err);
        console.warn("[usePipeline] START CATCH", { err });
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
    lastEventTimeRef.current = 0;
    setState(INITIAL_STATE);
  }, []);

  return { ...state, start, reset };
}
