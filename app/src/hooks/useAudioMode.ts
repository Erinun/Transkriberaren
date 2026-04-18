import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AudioModeInfo {
  detected_mode: string;
  has_microphone: boolean;
  output_device_name: string;
  microphone_name: string;
  used_fallback: boolean;
}

export interface OutputDeviceInfo {
  name: string;
  is_console_default: boolean;
  is_communications_default: boolean;
}

type AudioMode = "headphones" | "speakers";

interface UseAudioModeReturn {
  detectedMode: AudioMode | null;
  activeMode: AudioMode;
  isOverridden: boolean;
  hasMicrophone: boolean;
  outputDeviceName: string;
  microphoneName: string;
  usedFallback: boolean;
  outputDevices: OutputDeviceInfo[];
  manualOutputDevice: string | null;
  loading: boolean;
  error: string | null;
  toggleMode: () => void;
  setManualOutputDevice: (name: string | null) => void;
  stopPolling: () => void;
  startPolling: () => void;
}

const OVERRIDE_KEY_PREFIX = "motesskribent-audio-mode-override:";
const OUTPUT_OVERRIDE_KEY_PREFIX = "motesskribent-output-override:";
const OLD_DEVICE_KEY = "motesskribent-audio-device";

function overrideKey(deviceName: string): string {
  return `${OVERRIDE_KEY_PREFIX}${deviceName}`;
}

function outputOverrideKey(deviceName: string): string {
  return `${OUTPUT_OVERRIDE_KEY_PREFIX}${deviceName}`;
}

export function useAudioMode(): UseAudioModeReturn {
  const [detectedMode, setDetectedMode] = useState<AudioMode | null>(null);
  const [overriddenMode, setOverriddenMode] = useState<AudioMode | null>(null);
  const [hasMicrophone, setHasMicrophone] = useState(false);
  const [outputDeviceName, setOutputDeviceName] = useState("");
  const [microphoneName, setMicrophoneName] = useState("");
  const [usedFallback, setUsedFallback] = useState(false);
  const [outputDevices, setOutputDevices] = useState<OutputDeviceInfo[]>([]);
  const [manualOutputDevice, setManualOutputDeviceState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const activeMode: AudioMode = overriddenMode ?? detectedMode ?? "speakers";
  const isOverridden = overriddenMode !== null;

  const detect = useCallback(async () => {
    try {
      const [info, devices] = await Promise.all([
        invoke<AudioModeInfo>("detect_audio_mode"),
        invoke<OutputDeviceInfo[]>("list_output_devices"),
      ]);
      const mode = info.detected_mode === "headphones" ? "headphones" : "speakers";
      setDetectedMode(mode);
      setHasMicrophone(info.has_microphone);
      setOutputDeviceName(info.output_device_name);
      setMicrophoneName(info.microphone_name);
      setUsedFallback(info.used_fallback);
      setOutputDevices(devices);
      setError(null);

      // Load any existing mode override for this device
      const saved = localStorage.getItem(overrideKey(info.output_device_name));
      if (saved === "headphones" || saved === "speakers") {
        setOverriddenMode(saved);
      } else {
        setOverriddenMode(null);
      }

      // Load any existing output device override
      const savedOutput = localStorage.getItem(outputOverrideKey(info.output_device_name));
      if (savedOutput && devices.some((d) => d.name === savedOutput)) {
        setManualOutputDeviceState(savedOutput);
      } else {
        setManualOutputDeviceState(null);
        // Clean up stale override
        if (savedOutput) {
          localStorage.removeItem(outputOverrideKey(info.output_device_name));
        }
      }
    } catch (err: any) {
      const msg = typeof err === "string" ? err : err.message ?? "Kunde inte detektera ljudläge";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    intervalRef.current = setInterval(detect, 3000);
  }, [detect, stopPolling]);

  // Initial detect + start polling on mount
  useEffect(() => {
    // Migration: remove old localStorage key
    localStorage.removeItem(OLD_DEVICE_KEY);

    detect();
    startPolling();

    return () => {
      stopPolling();
    };
  }, [detect, startPolling, stopPolling]);

  const toggleMode = useCallback(() => {
    const newMode: AudioMode = activeMode === "headphones" ? "speakers" : "headphones";

    if (newMode === detectedMode) {
      // Toggling back to detected mode — remove the override
      setOverriddenMode(null);
      if (outputDeviceName) {
        localStorage.removeItem(overrideKey(outputDeviceName));
      }
    } else {
      // Setting an override
      setOverriddenMode(newMode);
      if (outputDeviceName) {
        localStorage.setItem(overrideKey(outputDeviceName), newMode);
      }
    }
  }, [activeMode, detectedMode, outputDeviceName]);

  const setManualOutputDevice = useCallback(
    (name: string | null) => {
      setManualOutputDeviceState(name);
      if (outputDeviceName) {
        if (name) {
          localStorage.setItem(outputOverrideKey(outputDeviceName), name);
        } else {
          localStorage.removeItem(outputOverrideKey(outputDeviceName));
        }
      }
    },
    [outputDeviceName],
  );

  return {
    detectedMode,
    activeMode,
    isOverridden,
    hasMicrophone,
    outputDeviceName,
    microphoneName,
    usedFallback,
    outputDevices,
    manualOutputDevice,
    loading,
    error,
    toggleMode,
    setManualOutputDevice,
    stopPolling,
    startPolling,
  };
}
