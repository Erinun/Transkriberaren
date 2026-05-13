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
import HistoryView from "./components/HistoryView";
import { ToastProvider, useToast } from "./components/Toast";
import UpdateChecker from "./components/UpdateChecker";
import { usePipeline, type PipelineSettings } from "./hooks/usePipeline";
import { useHistory, type HistoryEntry, type OllamaResult } from "./hooks/useHistory";
import { useOllamaStatus } from "./hooks/useOllama";
import { useRecorder } from "./hooks/useRecorder";
import { useAudioLevel } from "./hooks/useAudioLevel";

type View = "dashboard" | "transcribe" | "history" | "processing" | "result" | "settings" | "recording";
type SidecarStatus = "starting" | "warming_up" | "ready" | "error";

const NAV_ITEMS: { id: View; label: string }[] = [
  { id: "recording", label: "Spela in" },
  { id: "history", label: "Transkriptioner" },
  { id: "settings", label: "Inställningar" },
];

const STORAGE_KEY = "motesskribent-settings";

function loadSettingsForRecording(): PipelineSettings {
  let model = "KBLab/kb-whisper-base";
  let numSpeakers: number | null = null;
  let formats = ["markdown", "json"];
  let vadEnabled = true;
  let speedProfile = "balanced";

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      // Migrera ogiltiga modeller → base
      const validModels = ["KBLab/kb-whisper-tiny", "KBLab/kb-whisper-base", "KBLab/kb-whisper-small"];
      if (s.defaultModel && !validModels.includes(s.defaultModel)) {
        s.defaultModel = "KBLab/kb-whisper-base";
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
      }
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
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const { showToast } = useToast();
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
  const recorder = useRecorder();
  const isRecordingActive = recorder.status === "recording" || recorder.status === "paused";
  const audioLevels = useAudioLevel(isRecordingActive);

  // Check Ollama health on mount
  useEffect(() => {
    ollamaStatus.checkHealth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-start meeting detection if previously enabled
  useEffect(() => {
    if (localStorage.getItem("meetingDetectionEnabled") === "true") {
      invoke("set_meeting_detection", { enabled: true }).catch(() => {});
    }
  }, []);

  // Track the audio file name for the current transcription
  const [currentAudioName, setCurrentAudioName] = useState<string>("");

  // Track viewing a history entry
  const [viewingHistory, setViewingHistory] = useState<HistoryEntry | null>(null);

  // Track the current history entry ID (for saving ollama results)
  const [currentEntryId, setCurrentEntryId] = useState<string | null>(null);

  // Track where the transcription was started from (for back navigation)
  const [sourceView, setSourceView] = useState<View>("dashboard");

  // Track whether we already saved the current run to history
  const historySavedRef = useRef(false);
  // Track whether we already showed the toast for the current run
  const toastShownRef = useRef(false);
  // Track whether pipeline was started in this session (robust against view changes during processing)
  const pipelineActiveRef = useRef(false);
  // TODO: Framtida refaktor — ersätt pipelineActiveRef + ollamaActiveRef med en
  // gemensam "busyRef" som varje långkörande flöde opt-inar till, istället för
  // att meeting-detected-lyssnaren måste känna till varje flöde individuellt.
  const ollamaActiveRef = useRef(false);

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

  // Listen for meeting-detected event (from meeting detector / notification click)
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen("meeting-detected", () => {
      if (cancelled) return;
      console.log("[DIAG] meeting-detected event fired, activeView:", activeView, "pipelineActive:", pipelineActiveRef.current, "ollamaActive:", ollamaActiveRef.current);
      // Don't navigate away while pipeline or Ollama processing is actively running
      if (pipelineActiveRef.current || ollamaActiveRef.current) return;
      setActiveView("recording");
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
    setSourceView("transcribe");
    historySavedRef.current = false;
    toastShownRef.current = false;
    pipelineActiveRef.current = true;
    setActiveView("processing");
    pipeline.start(filePath, settings);
  };

  const handleRecordingComplete = async (filePath: string, settings: PipelineSettings, deviceName?: string) => {
    const freshSettings = loadSettingsForRecording();
    const outputDir = settings.outputDir || await invoke<string>("get_default_output_dir");
    let finalSettings = { ...freshSettings, outputDir, audioSource: deviceName ?? null };
    const name = filePath.split(/[\\/]/).pop() ?? filePath;
    setCurrentAudioName(name);
    setViewingHistory(null);
    setSourceView("recording");
    historySavedRef.current = false;
    toastShownRef.current = false;
    pipelineActiveRef.current = true;
    setActiveView("processing");
    pipeline.start(filePath, finalSettings);
  };

  // Auto-navigate when pipeline completes or errors, and save to history
  useEffect(() => {
    if ((pipeline.status === "done" || pipeline.status === "error") && pipelineActiveRef.current) {
      console.log("[DIAG] auto-navigate:", pipeline.status, "pipelineActive:", pipelineActiveRef.current, "activeView:", activeView);
      pipelineActiveRef.current = false;
      setActiveView("result");
    }
    if (pipeline.status === "done" && pipeline.mdContent && pipeline.summary && !historySavedRef.current) {
      historySavedRef.current = true;
      const id = history.addEntry(currentAudioName, pipeline.mdContent, pipeline.summary, pipeline.modelName, pipeline.wordCount);
      setCurrentEntryId(id);
      if (!toastShownRef.current) {
        toastShownRef.current = true;
        showToast("Transkribering klar!", "success");
      }
    }
    if (pipeline.status === "error" && !toastShownRef.current) {
      toastShownRef.current = true;
      showToast("Transkribering misslyckades", "error");
    }
  }, [pipeline.status, pipeline.mdContent, pipeline.summary]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleViewHistory = (entry: HistoryEntry) => {
    setViewingHistory(entry);
    setCurrentEntryId(entry.id);
    setActiveView("result");
  };

  const handleOllamaComplete = (result: OllamaResult) => {
    if (currentEntryId) {
      history.saveOllamaResult(currentEntryId, result);
    }
    showToast("Bearbetning klar!", "success");
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
          setActiveView("history");
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
          setActiveView(sourceView);
        },
        onRetranscribe: () => {
          pipeline.reset();
          setViewingHistory(null);
          setActiveView(sourceView);
        },
      };

  const showHeader = activeView !== "dashboard";

  return (
    <div className="flex flex-col h-screen">
      <UpdateChecker />
      {/* Header */}
      {showHeader && (
        <header className="flex items-center justify-between px-5 py-3 glass border-t-0 border-x-0 rounded-none">
          <button
            onClick={() => {
              if (pipeline.status === "running" && activeView === "processing") return;
              setViewingHistory(null);
              setActiveView("dashboard");
            }}
            className={`flex items-center gap-2 transition-opacity ${
              pipeline.status === "running" && activeView === "processing"
                ? "opacity-50 cursor-not-allowed"
                : "hover:opacity-80"
            }`}
          >
            <Logo size={28} />
            <span className="text-lg font-semibold tracking-tight">MötesSkribent</span>
          </button>
          <nav className="flex gap-1 items-center">
            {NAV_ITEMS.map((item) => {
              const isProcessing = pipeline.status === "running" && activeView === "processing";
              const disabled = isProcessing && item.id !== "processing";
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    if (disabled) return;
                    setViewingHistory(null);
                    setActiveView(item.id);
                  }}
                  disabled={disabled}
                  className={`px-3 py-1.5 rounded-md text-sm transition-colors ${
                    activeView === item.id
                      ? "bg-[var(--color-primary)] text-white"
                      : disabled
                        ? "text-[var(--color-text-muted)]/40 cursor-not-allowed"
                        : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5"
                  }`}
                >
                  <span className="relative">
                    {item.label}
                    {item.id === "recording" && isRecordingActive && activeView !== "recording" && (
                      <span
                        className="absolute -top-1 -right-2.5 w-2 h-2 rounded-full bg-[var(--color-error)] animate-pulse-rec"
                        title="Inspelning pågår"
                      />
                    )}
                  </span>
                </button>
              );
            })}
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
          {activeView === "history" && (
            <HistoryView
              entries={history.entries}
              onView={handleViewHistory}
              onRemove={history.removeEntry}
            />
          )}
          {activeView === "processing" && (
            <ProcessingView
              stage={pipeline.stage}
              percent={pipeline.percent}
              message={pipeline.message}
              isIndeterminate={pipeline.isIndeterminate}
              lastEventTime={pipeline.lastEventTime}
              startTime={pipeline.startTime}
              eventLog={pipeline.eventLog}
            />
          )}
          {activeView === "result" && (
            <ResultView
              {...resultProps}
              ollamaStatus={ollamaStatus}
              onOllamaComplete={handleOllamaComplete}
              ollamaActiveRef={ollamaActiveRef}
              savedOllamaResults={
                currentEntryId
                  ? history.entries.find((e) => e.id === currentEntryId)?.ollamaResults
                  : undefined
              }
            />
          )}
          {activeView === "settings" && <SettingsView ollamaStatus={ollamaStatus} />}
          {activeView === "recording" && (
            <RecordingView
              onRecordingComplete={handleRecordingComplete}
              settings={recordingSettings}
              recorder={recorder}
              audioLevels={audioLevels}
            />
          )}
        </div>
      </main>

      {/* Info modal */}
      <InfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} />
    </div>
  );
}
