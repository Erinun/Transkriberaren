import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Logo from "./components/Logo";
import DashboardView from "./components/DashboardView";
import InfoModal from "./components/InfoModal";
import TranscribeView from "./components/TranscribeView";
import ProcessingView from "./components/ProcessingView";
import ResultView from "./components/ResultView";
import SettingsView from "./components/SettingsView";
import RecordingView from "./components/RecordingView";
import { usePipeline, type PipelineSettings } from "./hooks/usePipeline";
import { useHistory, type HistoryEntry } from "./hooks/useHistory";
import { useOllamaStatus } from "./hooks/useOllama";

type View = "dashboard" | "transcribe" | "processing" | "result" | "settings" | "recording";
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
  let speedProfile = "balanced";

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
      if (s.defaultSpeedProfile) speedProfile = s.defaultSpeedProfile;
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
    speedProfile,
    audioSource: null,
  };
}

export default function App() {
  const [activeView, setActiveView] = useState<View>("dashboard");
  const [recordingSettings, setRecordingSettings] = useState<PipelineSettings>(
    loadSettingsForRecording
  );
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>("starting");
  const [diarizationAvailable, setDiarizationAvailable] = useState<boolean>(true);
  const [infoOpen, setInfoOpen] = useState(false);
  const pipeline = usePipeline();
  const history = useHistory();
  const ollamaStatus = useOllamaStatus();

  // Check Ollama health on mount
  useEffect(() => {
    ollamaStatus.checkHealth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Track the audio file name for the current transcription
  const [currentAudioName, setCurrentAudioName] = useState<string>("");

  // Track viewing a history entry
  const [viewingHistory, setViewingHistory] = useState<HistoryEntry | null>(null);

  // Track whether we already saved the current run to history
  const historySavedRef = useRef(false);

  // Listen for sidecar status events
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<string>("sidecar-status", (event) => {
      if (cancelled) return;
      setSidecarStatus(event.payload as SidecarStatus);
    }).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Listen for diarization availability
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<boolean>("diarization-status", (event) => {
      if (cancelled) return;
      setDiarizationAvailable(event.payload);
    }).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
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

  const handleRecordingComplete = async (filePath: string, settings: PipelineSettings, deviceName?: string) => {
    let finalSettings = { ...settings, audioSource: deviceName ?? null };
    if (!finalSettings.outputDir) {
      const dir = await invoke<string>("get_default_output_dir");
      finalSettings = { ...finalSettings, outputDir: dir };
    }
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setCurrentAudioName(name);
    setViewingHistory(null);
    historySavedRef.current = false;
    setActiveView("processing");
    pipeline.start(filePath, finalSettings);
  };

  // Auto-navigate when pipeline completes or errors, and save to history
  useEffect(() => {
    if ((pipeline.status === "done" || pipeline.status === "error") && activeView === "processing") {
      setActiveView("result");
    }
    if (pipeline.status === "done" && pipeline.mdContent && pipeline.summary && !historySavedRef.current) {
      historySavedRef.current = true;
      history.addEntry(currentAudioName, pipeline.mdContent, pipeline.summary, pipeline.modelName, pipeline.wordCount);
    }
  }, [pipeline.status, pipeline.mdContent, pipeline.summary, activeView]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewHistory = (entry: HistoryEntry) => {
    setViewingHistory(entry);
    setActiveView("result");
  };

  const sidecarReady = sidecarStatus === "ready" || sidecarStatus === "error";

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
        segments: [],
        modelName: viewingHistory!.modelName ?? null,
        wordCount: viewingHistory!.wordCount ?? 0,
        onBack: () => {
          setViewingHistory(null);
          setActiveView("dashboard");
        },
      }
    : {
        status: pipeline.status,
        error: pipeline.error,
        outputFiles: pipeline.outputFiles,
        summary: pipeline.summary,
        mdContent: pipeline.mdContent,
        warnings: pipeline.warnings,
        segments: pipeline.segments,
        modelName: pipeline.modelName,
        wordCount: pipeline.wordCount,
        onBack: () => {
          pipeline.reset();
          setViewingHistory(null);
          setActiveView("transcribe");
        },
        onRetranscribe: () => {
          pipeline.reset();
          setViewingHistory(null);
          setActiveView("transcribe");
        },
      };

  const showHeader = activeView !== "dashboard";

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      {showHeader && (
        <header className="flex items-center justify-between px-5 py-3 glass border-t-0 border-x-0 rounded-none">
          <button
            onClick={() => {
              setViewingHistory(null);
              setActiveView("dashboard");
            }}
            className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <Logo size={28} />
            <span className="text-lg font-semibold tracking-tight">MötesSkribent</span>
          </button>
          <nav className="flex gap-1 items-center">
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
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5"
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              onClick={() => setInfoOpen(true)}
              className="ml-2 w-8 h-8 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5 transition-colors"
              title="Information"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          </nav>
        </header>
      )}

      {/* Content */}
      <main className={`flex-1 ${activeView === "result" ? "overflow-hidden" : "overflow-y-auto p-6"}`}>
        <div className={activeView === "result" ? "h-full" : ""}>
          {activeView === "dashboard" && (
            <DashboardView
              onNavigate={setActiveView}
              sidecarReady={sidecarReady}
              onInfoClick={() => setInfoOpen(true)}
              ollamaStatus={ollamaStatus}
            />
          )}
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
          {activeView === "result" && <ResultView {...resultProps} ollamaStatus={ollamaStatus} />}
          {activeView === "settings" && <SettingsView ollamaStatus={ollamaStatus} />}
          {activeView === "recording" && (
            <RecordingView
              onRecordingComplete={handleRecordingComplete}
              settings={recordingSettings}
            />
          )}
        </div>
      </main>

      {/* Info modal */}
      <InfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
}
