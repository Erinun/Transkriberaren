import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface AudioDevice {
  id: string;
  name: string;
  is_loopback: boolean;
  category: string;
}

const STORAGE_KEY = "motesskribent-audio-device";

export function useAudioDevices() {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("default_input");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<AudioDevice[]>("list_audio_devices");
      setDevices(list);

      // Restore saved selection
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && list.some((d) => d.id === saved)) {
        setSelectedDeviceId(saved);
      } else {
        setSelectedDeviceId("default_input");
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

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const selectDevice = useCallback((id: string) => {
    setSelectedDeviceId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }, []);

  return { devices, selectedDeviceId, selectDevice, loading, error, refresh: fetchDevices };
}
