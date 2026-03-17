import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TranscribeView from "./components/TranscribeView";
import ProcessingView from "./components/ProcessingView";
import ResultView from "./components/ResultView";
import SettingsView from "./components/SettingsView";
import RecordingView from "./components/RecordingView";
import { usePipeline, type PipelineSettings } from "./hooks/usePipeline";
import { useHistory, type HistoryEntry } from "./hooks/useHistory";

type View = "transcribe" | "processing" | "result" | "settings" | "recording";
type SidecarStatus = "starting" | "warming_up" | "ready" | "error";

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "transcribe", label: "Transkribera" },
  { id: "recording", label: "Spela in" },
  { id: "settings", label: "Inställningar" },
];

const STORAGE_KEY = "motesskribent-settings";

function loadSettingsForRecording(): PipelineSettings {
  let model = "KBLab/kb-whisper-small";
  let numSpeakers: number | null = null;
  let formats = ["markdown", "json"];
  let vadEnabled = true;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s.defaultModel) model = s.defaultModel;
      if (s.defaultNumSpeakers && s.defaultNumSpeakers !== "") {
        numSpeakers = parseInt(s.defaultNumSpeakers);
      }
      if (s.defaultFormats) {
        const fmtList: string[] = [];
        if (s.defaultFormats.markdown) fmtList.push("markdown");
        if (s.defaultFormats.json) fmtList.push("json");
        if (s.defaultFormats.docx) fmtList.push("docx");
        if (fmtList.length > 0) formats = fmtList;
      }
      if (typeof s.vadEnabled === "boolean") vadEnabled = s.vadEnabled;
    }
  } catch {}

  let outputDir = "";

  return {
    model,
    numSpeakers,
    formats,
    outputDir,
    vadEnabled,
    prompt: null,
  };
}

const STATUS_MESSAGES: Record<SidecarStatus, string> = {
  starting: "Startar...",
  warming_up: "Laddar modeller...",
  ready: "",
  error: "Kunde inte starta AI-motorn",
};

export default function App() {
  const [activeView, setActiveView] = useState<View>("transcribe");
  const [recordingSettings, setRecordingSettings] = useState<PipelineSettings>(
    loadSettingsForRecording
  );
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>("starting");
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean>(true);
  const pipeline = usePipeline();
  const history = useHistory();

  // Track the audio file name for the current transcription
  const [currentAudioName, setCurrentAudioName] = useState<string>("");

  // Track viewing a history entry
  const [viewingHistory, setViewingHistory] = useState<HistoryEntry | null>(null);

  // Track whether we already saved the current run to history
  const historySavedRef = useRef(false);

  // Listen for sidecar status events
  useEffect(() => {
    const unlisten = listen<string>("sidecar-status", (event) => {
      setSidecarStatus(event.payload as SidecarStatus);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Listen for diarization availability
  useEffect(() => {
    const unlisten = listen<boolean>("diarization-status", (event) => {
      setDiarizationAvailable(event.payload);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Fetch default output dir once for recording settings
  useEffect(() => {
    invoke<string>("get_default_output_dir").then((dir) => {
      setRecordingSettings((s) => ({ ...s, outputDir: dir }));
    });
  }, []);

  const handleStart = (filePath: string, settings: PipelineSettings) => {
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setCurrentAudioName(name);
    setViewingHistory(null);
    historySavedRef.current = false;
    setActiveView("processing");
    pipeline.start(filePath, settings);
  };

  const handleRecordingComplete = async (filePath: string, settings: PipelineSettings) => {
    let finalSettings = settings;
    if (!settings.outputDir) {
      const dir = await invoke<string>("get_default_output_dir");
      finalSettings = { ...settings, outputDir: dir };
    }
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setCurrentAudioName(name);
    setViewingHistory(null);
    historySavedRef.current = false;
    setActiveView("processing");
    pipeline.start(filePath, finalSettings);
  };

  // Auto-navigate when pipeline completes or errors
  if (pipeline.status === "done" && activeView === "processing") {
    setActiveView("result");
  }
  if (pipeline.status === "error" && activeView === "processing") {
    setActiveView("result");
  }

  // Save to history when pipeline completes
  if (
    pipeline.status === "done" &&
    pipeline.mdContent &&
    pipeline.summary &&
    !historySavedRef.current
  ) {
    historySavedRef.current = true;
    history.addEntry(currentAudioName, pipeline.mdContent, pipeline.summary);
  }

  const handleViewHistory = (entry: HistoryEntry) => {
    setViewingHistory(entry);
    setActiveView("result");
  };

  const appReady = sidecarStatus === "ready" || sidecarStatus === "error";

  // Loading screen while sidecar is starting up
  if (!appReady) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <div className="w-10 h-10 border-4 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
        <p className="text-[var(--color-text-muted)] text-sm">
          {STATUS_MESSAGES[sidecarStatus]}
        </p>
      </div>
    );
  }

  // Determine what to show in ResultView
  const showingHistory = viewingHistory !== null && activeView === "result";
  const resultProps = showingHistory
    ? {
        status: "done" as const,
        error: null,
        outputFiles: [],
        summary: viewingHistory!.summary,
        mdContent: viewingHistory!.mdContent,
        warnings: [],
        onBack: () => {
          setViewingHistory(null);
          setActiveView("transcribe");
        },
      }
    : {
        status: pipeline.status,
        error: pipeline.error,
        outputFiles: pipeline.outputFiles,
        summary: pipeline.summary,
        mdContent: pipeline.mdContent,
        warnings: pipeline.warnings,
        onBack: () => {
          pipeline.reset();
          setViewingHistory(null);
          setActiveView("transcribe");
        },
      };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold tracking-tight">MötesSkribent</h1>
        <nav className="flex gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                setViewingHistory(null);
                setActiveView(item.id);
              }}
              className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                activeView === item.id
                  ? "bg-[var(--color-primary)] text-white"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto p-6">
        {activeView === "transcribe" && (
          <TranscribeView
            onStart={handleStart}
            history={history.entries}
            onViewHistory={handleViewHistory}
            diarizationAvailable={diarizationAvailable}
          />
        )}
        {activeView === "processing" && (
          <ProcessingView
            stage={pipeline.stage}
            percent={pipeline.percent}
            message={pipeline.message}
          />
        )}
        {activeView === "result" && <ResultView {...resultProps} />}
        {activeView === "settings" && <SettingsView />}
        {activeView === "recording" && (
          <RecordingView
            onRecordingComplete={handleRecordingComplete}
            settings={recordingSettings}
          />
        )}
      </main>
    </div>
  );
}
