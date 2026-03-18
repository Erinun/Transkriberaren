import { useState, useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const BAR_COUNT = 24;
const GAIN = 8.0;
const SMOOTHING = 0.15;

export function useAudioLevel(active: boolean): number[] {
  const [levels, setLevels] = useState<number[]>(() => new Array(BAR_COUNT).fill(0));
  const bufRef = useRef<number[]>(new Array(BAR_COUNT).fill(0));

  useEffect(() => {
    if (!active) {
      bufRef.current = new Array(BAR_COUNT).fill(0);
      setLevels(new Array(BAR_COUNT).fill(0));
      return;
    }

    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    listen<{ level: number }>("recording-level", (event) => {
      const amplified = Math.min(event.payload.level * GAIN, 1.0);
      const raw = Math.sqrt(amplified);
      const buf = bufRef.current;

      // Shift left (scrolling effect)
      for (let i = 0; i < BAR_COUNT - 1; i++) {
        buf[i] = buf[i + 1];
      }

      // Exponential smoothing on newest value
      const prev = buf[BAR_COUNT - 1];
      buf[BAR_COUNT - 1] = prev * SMOOTHING + raw * (1 - SMOOTHING);

      setLevels([...buf]);
    }).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });

    return () => { cancelled = true; unlisten?.(); };
  }, [active]);

  return levels;
}
