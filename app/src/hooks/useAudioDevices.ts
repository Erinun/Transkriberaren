import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AudioDevice {
  id: string;
  name: string;
  is_loopback: boolean;
  category: string;
  is_active: boolean;
}

const STORAGE_KEY = "motesskribent-audio-device";

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("mic_and_system");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<AudioDevice[]>("list_audio_devices");
      setDevices(list);

      // Restore saved selection, or auto-select best device
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && list.some((d) => d.id === saved)) {
        setSelectedDeviceId(saved);
      } else {
        autoSelectBestDevice(list);
      }
    } catch (err: any) {
      const msg = typeof err === "string" ? err : err.message ?? "";
      if (msg.includes("reading 'invoke'")) {
        setError("Tauri API ej tillgängligt. Starta appen med 'cargo tauri dev', inte via webbläsare.");
      } else {
        setError(msg || "Kunde inte lista enheter");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const autoSelectBestDevice = useCallback((list: AudioDevice[]) => {
    // 1. Prefer active "mixed" device (mic + system with audio playing)
    const activeMixed = list.find((d) => d.category === "mixed" && d.is_active);
    if (activeMixed) {
      setSelectedDeviceId(activeMixed.id);
      return;
    }

    // 2. Fallback to generic "mic_and_system"
    const hasMixed = list.some((d) => d.id === "mic_and_system");
    if (hasMixed) {
      setSelectedDeviceId("mic_and_system");
      return;
    }

    // 3. Last resort: default mic
    setSelectedDeviceId("default_input");
  }, []);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Poll for active devices every 3 seconds (only when not recording)
  const startPolling = useCallback(() => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const list = await invoke<AudioDevice[]>("list_audio_devices");
        setDevices(list);
      } catch {
        // Ignore polling errors
      }
    }, 3000);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Start polling on mount, clean up on unmount
  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const selectDevice = useCallback((id: string) => {
    setSelectedDeviceId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  return {
    devices,
    selectedDeviceId,
    selectDevice,
    loading,
    error,
    refresh: fetchDevices,
    stopPolling,
    startPolling,
  };
}
