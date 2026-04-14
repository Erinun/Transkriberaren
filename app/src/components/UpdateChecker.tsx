import { useState, useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type UpdateState = "idle" | "available" | "downloading" | "ready" | "error";

export default function UpdateChecker() {
  const [state, setState] = useState<UpdateState>("idle");
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function checkForUpdate() {
      try {
        const update = await check();
        if (cancelled || !update) return;

        setVersion(update.version);
        setState("available");

        // Store the update object for later download
        (window as any).__tauriUpdate = update;
      } catch {
        // Silently ignore — no network or no update available
      }
    }

    // Check after 3 seconds to not block app startup
    const timer = setTimeout(checkForUpdate, 3000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const handleUpdate = async () => {
    const update = (window as any).__tauriUpdate;
    if (!update) return;

    setState("downloading");
    try {
      let totalLength = 0;
      let downloaded = 0;

      await update.downloadAndInstall((event: any) => {
        if (event.event === "Started" && event.data?.contentLength) {
          totalLength = event.data.contentLength;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          if (totalLength > 0) {
            setProgress(Math.round((downloaded / totalLength) * 100));
          }
        }
      });

      setState("ready");
    } catch {
      setState("error");
    }
  };

  const handleRelaunch = async () => {
    try {
      await relaunch();
    } catch {
      setState("error");
    }
  };

  if (state === "idle") return null;

  return (
    <div className="flex items-center justify-center gap-3 px-4 py-2 text-sm bg-[var(--color-primary)]/10 border-b border-[var(--color-primary)]/20">
      {state === "available" && (
        <>
          <span>Ny version {version} finns tillgänglig!</span>
          <button
            onClick={handleUpdate}
            className="px-3 py-1 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity"
          >
            Uppdatera nu
          </button>
        </>
      )}
      {state === "downloading" && (
        <>
          <span>Laddar ner uppdatering... {progress > 0 ? `${progress}%` : ""}</span>
          <div className="w-32 h-1.5 bg-white/10 rounded-full overflow-hidden">
            <div
              className="h-full bg-[var(--color-primary)] transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </>
      )}
      {state === "ready" && (
        <>
          <span>Uppdatering klar!</span>
          <button
            onClick={handleRelaunch}
            className="px-3 py-1 rounded-md text-xs font-medium bg-[var(--color-primary)] text-white hover:opacity-90 transition-opacity"
          >
            Starta om
          </button>
        </>
      )}
      {state === "error" && (
        <span className="text-red-400">Uppdateringen misslyckades. Försök igen senare.</span>
      )}
    </div>
  );
}
