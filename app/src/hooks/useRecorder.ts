import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface RecordingResult {
  path: string;
  device_name: string;
}

type RecorderStatus = "idle" | "recording" | "stopping";

interface RecorderState {
  status: RecorderStatus;
  elapsedSeconds: number;
  error: string | null;
  warning: string | null;
  deviceName: string | null;
}

const INITIAL_STATE: RecorderState = {
  status: "idle",
  elapsedSeconds: 0,
  error: null,
  warning: null,
  deviceName: null,
};

export function useRecorder() {
  const [state, setState] = useState<RecorderState>(INITIAL_STATE);

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;

    listen<{ elapsed_seconds: number }>("recording-tick", (event) => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        elapsedSeconds: event.payload.elapsed_seconds,
      }));
    }).then((fn) => {
      if (cancelled) fn(); else unlisteners.push(fn);
    });

    listen<{ message: string }>("recording-error", (event) => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        status: "idle",
        error: event.payload.message,
      }));
    }).then((fn) => {
      if (cancelled) fn(); else unlisteners.push(fn);
    });

    listen<{ message: string }>("recording-warning", (event) => {
      if (cancelled) return;
      setState((s) => ({
        ...s,
        warning: event.payload.message,
      }));
    }).then((fn) => {
      if (cancelled) fn(); else unlisteners.push(fn);
    });

    return () => { cancelled = true; unlisteners.forEach((fn) => fn()); };
  }, []);

  const start = useCallback(async (deviceId?: string) => {
    setState({ status: "recording", elapsedSeconds: 0, error: null, warning: null, deviceName: null });
    try {
      const deviceName = await invoke<string>("start_recording", { deviceId });
      setState((s) => ({ ...s, deviceName }));
    } catch (err: any) {
      const msg = typeof err === "string" ? err : err.message ?? "";
      const tauriMissing = msg.includes("reading 'invoke'");
      setState({
        status: "idle",
        elapsedSeconds: 0,
        error: tauriMissing
          ? "Tauri API ej tillgängligt. Starta appen med 'cargo tauri dev', inte via webbläsare."
          : msg || "Okänt fel",
        warning: null,
        deviceName: null,
      });
    }
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    setState((s) => ({ ...s, status: "stopping" }));
    try {
      const result = await invoke<RecordingResult>("stop_recording");
      setState(INITIAL_STATE);
      return result;
    } catch (err: any) {
      const msg = typeof err === "string" ? err : err.message ?? "";
      const tauriMissing = msg.includes("reading 'invoke'");
      setState({
        status: "idle",
        elapsedSeconds: 0,
        error: tauriMissing
          ? "Tauri API ej tillgängligt. Starta appen med 'cargo tauri dev', inte via webbläsare."
          : msg || "Okänt fel",
        warning: null,
        deviceName: null,
      });
      return null;
    }
  }, []);

  return { ...state, start, stop };
}
