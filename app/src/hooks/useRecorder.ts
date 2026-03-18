import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type RecorderStatus = "idle" | "recording" | "stopping";

interface RecorderState {
  status: RecorderStatus;
  elapsedSeconds: number;
  error: string | null;
}

const INITIAL_STATE: RecorderState = {
  status: "idle",
  elapsedSeconds: 0,
  error: null,
};

export function useRecorder() {
  const [state, setState] = useState<RecorderState>(INITIAL_STATE);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    listen<{ elapsed_seconds: number }>("recording-tick", (event) => {
      setState((s) => ({
        ...s,
        elapsedSeconds: event.payload.elapsed_seconds,
      }));
    }).then((fn) => {
      if (cancelled) fn(); else unlisteners.push(fn);
    });

    listen<{ message: string }>("recording-error", (event) => {
      setState((s) => ({
        ...s,
        status: "idle",
        error: event.payload.message,
      }));
    }).then((fn) => {
      if (cancelled) fn(); else unlisteners.push(fn);
    });

    return () => { cancelled = true; unlisteners.forEach((fn) => fn()); };
  }, []);

  const start = useCallback(async () => {
    setState({ status: "recording", elapsedSeconds: 0, error: null });
    try {
      await invoke("start_recording");
    } catch (err: any) {
      setState({
        status: "idle",
        elapsedSeconds: 0,
        error: typeof err === "string" ? err : err.message ?? "Okänt fel",
      });
    }
  }, []);

  const stop = useCallback(async (): Promise<string | null> => {
    setState((s) => ({ ...s, status: "stopping" }));
    try {
      const path = await invoke<string>("stop_recording");
      setState(INITIAL_STATE);
      return path;
    } catch (err: any) {
      setState({
        status: "idle",
        elapsedSeconds: 0,
        error: typeof err === "string" ? err : err.message ?? "Okänt fel",
      });
      return null;
    }
  }, []);

  return { ...state, start, stop };
}
