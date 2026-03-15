import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import TranscribeView from "./components/TranscribeView";
import ProcessingView from "./components/ProcessingView";
import ResultView from "./components/ResultView";
import SettingsView from "./components/SettingsView";
import RecordingView from "./components/RecordingView";
import { usePipeline, type PipelineSettings } from "./hooks/usePipeline";

type View = "transcribe" | "processing" | "result" | "settings" | "recording";

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
        if (fmtList.length > 0) formats = fmtList;
      }
      if (typeof s.vadEnabled === "boolean") vadEnabled = s.vadEnabled;
    }
  } catch {}

  // Build output dir — will be overridden async if needed
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

export default function App() {
  const [activeView, setActiveView] = useState<View>("transcribe");
  const [recordingSettings, setRecordingSettings] = useState<PipelineSettings>(
    loadSettingsForRecording
  );
  const pipeline = usePipeline();

  // Fetch default output dir once for recording settings
  useEffect(() => {
    invoke<string>("get_default_output_dir").then((dir) => {
      setRecordingSettings((s) => ({ ...s, outputDir: dir }));
    });
  }, []);

  const handleStart = (filePath: string, settings: PipelineSettings) => {
    setActiveView("processing");
    pipeline.start(filePath, settings);
  };

  const handleRecordingComplete = async (filePath: string, settings: PipelineSettings) => {
    let finalSettings = settings;
    if (!settings.outputDir) {
      const dir = await invoke<string>("get_default_output_dir");
      finalSettings = { ...settings, outputDir: dir };
    }
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

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 bg-[var(--color-surface)] border-b border-[var(--color-border)]">
        <h1 className="text-lg font-semibold tracking-tight">MötesSkribent</h1>
        <nav className="flex gap-1">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
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
          <TranscribeView onStart={handleStart} />
        )}
        {activeView === "processing" && (
          <ProcessingView
            stage={pipeline.stage}
            percent={pipeline.percent}
            message={pipeline.message}
          />
        )}
        {activeView === "result" && (
          <ResultView
            status={pipeline.status}
            error={pipeline.error}
            outputFiles={pipeline.outputFiles}
            summary={pipeline.summary}
            onBack={() => {
              pipeline.reset();
              setActiveView("transcribe");
            }}
          />
        )}
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
