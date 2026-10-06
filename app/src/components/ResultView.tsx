import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import { generateDocxBase64 } from "../lib/generateDocx";
import { engineLabel } from "../lib/engines";
import type { TranscriptionSegment } from "../hooks/usePipeline";
import type { AiResult } from "../hooks/useHistory";
import { useLlm, type LlmStatus } from "../hooks/useLlm";
import { hostOf } from "../lib/aiProviders";
import { usePromptTemplates } from "../hooks/usePromptTemplates";
import CustomSelect from "./CustomSelect";
import {
  buildPrompt,
  type PromptTemplate,
} from "../data/promptTemplates";

interface Summary {
  total_duration: number;
  speech_duration: number;
  processing_time: number;
  num_speakers: number;
  num_segments: number;
}

interface Props {
  status: "done" | "error" | string;
  error: string | null;
  outputFiles: string[];
  summary: Summary | null;
  mdContent: string | null;
  warnings: string[];
  onBack: () => void;
  segments: TranscriptionSegment[];
  modelName: string | null;
  engine?: string | null;
  wordCount: number;
  onRetranscribe?: () => void;
  llmStatus: LlmStatus;
  onAiComplete?: (result: AiResult) => void;
  savedAiResults?: AiResult[];
  aiActiveRef?: React.MutableRefObject<boolean>;
}

type ViewMode = "transcription" | "segment";
type ContentView = "transcription" | "ai";

function formatTime(seconds: number): string {
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} min ${s} sek` : `${s} sek`;
}

function formatTimestamp(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function extractModelShortName(modelName: string | null): string {
  if (!modelName) return "-";
  // "KBLab/kb-whisper-small" -> "kb-whisper-small"
  const parts = modelName.split("/");
  return parts[parts.length - 1];
}

function renderMarkdown(content: string) {
  return content.split("\n").map((line, i) => {
    if (line.startsWith("# ")) {
      return (
        <h1 key={i} className="text-xl font-bold mb-3">
          {line.slice(2)}
        </h1>
      );
    }
    if (line.startsWith("## ")) {
      return (
        <h2 key={i} className="text-lg font-semibold mt-4 mb-2">
          {line.slice(3)}
        </h2>
      );
    }
    if (line.startsWith("**") && line.includes(":**")) {
      const boldEnd = line.indexOf(":**") + 3;
      const label = line.slice(2, boldEnd - 2);
      const rest = line.slice(boldEnd);
      return (
        <p key={i} className="mt-3 mb-1">
          <strong className="text-[var(--color-primary)]">{label}</strong>
          {rest}
        </p>
      );
    }
    if (line.match(/^-{3,}$/)) {
      return <hr key={i} className="my-3 border-white/5" />;
    }
    if (line.trim() === "") {
      return <div key={i} className="h-2" />;
    }
    return (
      <p key={i} className="leading-relaxed">
        {line}
      </p>
    );
  });
}

export default function ResultView({
  status,
  error,
  outputFiles,
  summary,
  mdContent,
  warnings,
  onBack,
  segments,
  modelName,
  engine,
  wordCount,
  onRetranscribe,
  llmStatus,
  onAiComplete,
  savedAiResults,
  aiActiveRef,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("transcription");
  const [contentView, setContentView] = useState<ContentView>(
    () => (savedAiResults && savedAiResults.length > 0) ? "ai" : "transcription"
  );
  const [fontSize, setFontSize] = useState(14);
  const [showTimestamps, setShowTimestamps] = useState(true);

  // AI state (declared early so useEffects below can reference it)
  const ai = useLlm(llmStatus);

  // Sync AI generating state to App-level ref for meeting-detected guard
  useEffect(() => {
    if (aiActiveRef) aiActiveRef.current = ai.generating;
    return () => { if (aiActiveRef) aiActiveRef.current = false; };
  }, [ai.generating, aiActiveRef]);

  // Saved AI result viewing (for history entries)
  const [viewingSavedResult, setViewingSavedResult] = useState<AiResult | null>(
    () => savedAiResults?.[0] ?? null,
  );

  // Sync viewingSavedResult and contentView when switching between history entries
  // Skip view reset if AI generation is actively in progress or has unsaved text
  useEffect(() => {
    const hasSaved = savedAiResults && savedAiResults.length > 0;
    if (hasSaved) {
      setViewingSavedResult(savedAiResults[0]);
      setContentView("ai");
    } else if (!ai.generating && !ai.streamedText && !ai.error) {
      setViewingSavedResult(null);
      setContentView("transcription");
    }
  }, [savedAiResults, ai.generating, ai.streamedText, ai.error]);

  // Track generating→done transition to auto-save
  const wasGeneratingRef = useRef(false);
  const { templates: allTemplates } = usePromptTemplates();
  const [selectedTemplate, setSelectedTemplate] = useState<PromptTemplate>(
    allTemplates[0],
  );
  const generatingTemplateRef = useRef(selectedTemplate);

  // Revalidate selectedTemplate if it was removed
  useEffect(() => {
    if (!allTemplates.find((t) => t.id === selectedTemplate.id)) {
      setSelectedTemplate(allTemplates[0]);
    }
  }, [allTemplates, selectedTemplate.id]);
  // Detect generating→done and save result
  useEffect(() => {
    if (ai.generating) {
      wasGeneratingRef.current = true;
      generatingTemplateRef.current = selectedTemplate;
    } else if (wasGeneratingRef.current && ai.streamedText && !ai.error) {
      wasGeneratingRef.current = false;
      if (onAiComplete) {
        onAiComplete({
          templateId: generatingTemplateRef.current.id,
          templateName: generatingTemplateRef.current.name,
          model: ai.current.model,
          content: ai.streamedText,
          generatedAt: new Date().toISOString(),
        });
      }
    }
  }, [ai.generating]); // eslint-disable-line react-hooks/exhaustive-deps

  const [customPrompt, setCustomPrompt] = useState("");
  const [extraContext, setExtraContext] = useState("");
  const [showContext, setShowContext] = useState(false);

  const mdFile = outputFiles.find((f) => f.endsWith(".md"));
  const hasSegments = segments.length > 0;

  // Group speakers for unique colors
  const speakerColors = useMemo(() => {
    const colors = [
      "var(--color-primary)",
      "#22c55e",
      "#f59e0b",
      "#06b6d4",
      "#ec4899",
      "#a855f7",
    ];
    const map = new Map<string, string>();
    let idx = 0;
    for (const seg of segments) {
      const key = seg.speaker_id ?? "unknown";
      if (!map.has(key)) {
        map.set(key, colors[idx % colors.length]);
        idx++;
      }
    }
    return map;
  }, [segments]);

  const handleSaveAs = async () => {
    if (!mdContent) return;
    const defaultName = mdFile
      ? mdFile.split(/[\\/]/).pop() ?? "transkribering.md"
      : "transkribering.md";
    try {
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (!dest) return;
      setSaving(true);
      await invoke("write_text_to_file", {
        content: mdContent,
        destination: dest,
      });
    } catch (err) {
      console.error("Could not save file:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveDocx = async () => {
    const content =
      contentView === "ai"
        ? (ai.streamedText || viewingSavedResult?.content)
        : mdContent;
    if (!content) return;

    const defaultName =
      contentView === "ai"
        ? `${(viewingSavedResult?.templateName ?? selectedTemplate.name).toLowerCase().replace(/\s+/g, "_")}.docx`
        : "transkribering.docx";
    try {
      const dest = await save({
        defaultPath: defaultName,
        filters: [{ name: "Word-dokument", extensions: ["docx"] }],
      });
      if (!dest) return;
      setSaving(true);
      const dataBase64 = await generateDocxBase64(content);
      await invoke("write_binary_to_file", { dataBase64, destination: dest });
    } catch (err) {
      console.error("Could not save docx:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    const textToCopy =
      contentView === "ai" && (ai.streamedText || viewingSavedResult?.content)
        ? (ai.streamedText || viewingSavedResult?.content)
        : mdContent;
    if (!textToCopy) return;
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Could not copy:", err);
    }
  };

  const handleGenerate = () => {
    if (!mdContent) return;
    const prompt = buildPrompt(
      selectedTemplate,
      mdContent,
      extraContext,
      selectedTemplate.isCustom ? customPrompt : undefined,
    );
    ai.generate(prompt);
    setContentView("ai");
  };

  if (status === "error") {
    return (
      <div className="max-w-xl mx-auto mt-16 space-y-6 animate-fade-in">
        <div
          className="p-4 rounded-xl glass"
          style={{ borderColor: "rgba(239, 68, 68, 0.3)" }}
        >
          <h3 className="text-[var(--color-error)] font-medium">
            Fel vid transkribering
          </h3>
          <p className="text-sm mt-1 text-[var(--color-text-muted)]">
            {error}
          </p>
        </div>
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg glass hover:bg-white/5 text-sm transition-colors"
        >
          Tillbaka
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full animate-fade-in">
      {/* Warnings */}
      {warnings.length > 0 && (
        <div
          className="mx-4 mt-2 mb-0 p-3 rounded-xl glass"
          style={{ borderColor: "rgba(245, 158, 11, 0.3)" }}
        >
          {warnings.map((w, i) => (
            <p key={i} className="text-sm text-yellow-200">
              {w}
            </p>
          ))}
        </div>
      )}

      {/* Stats bar */}
      {summary && (
        <div className="flex items-center gap-4 px-5 py-3 text-xs text-[var(--color-text-muted)] border-b border-white/5">
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
            <span>Längd: <span className="text-[var(--color-text)] font-medium">{formatTime(summary.total_duration)}</span></span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            <span>Bearb.tid: <span className="text-[var(--color-text)] font-medium">{formatTime(summary.processing_time)}</span></span>
          </div>
          {wordCount > 0 && (
            <div className="flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              <span>Ord: <span className="text-[var(--color-text)] font-medium">{wordCount.toLocaleString("sv-SE")}</span></span>
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
            <span>
              {engine && <>Motor: <span className="text-[var(--color-text)] font-medium">{engineLabel(engine)}</span>{" · "}</>}
              Modell: <span className="text-[var(--color-text)] font-medium">{extractModelShortName(modelName)}</span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <span>Talare: <span className="text-[var(--color-text)] font-medium">{summary.num_speakers}</span></span>
          </div>
        </div>
      )}

      {/* Main layout: content + sidebar */}
      <div className="flex flex-1 min-h-0">
        {/* Main content area */}
        <div className="flex-1 overflow-y-auto p-5" style={{ fontSize }}>
          {contentView === "ai" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
                  {ai.streamedText
                    ? selectedTemplate.name
                    : viewingSavedResult?.templateName ?? selectedTemplate.name}
                </h3>
                {ai.generating && (
                  <div className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-glow-pulse" />
                )}
              </div>
              {/* Saved result dropdown (when multiple saved and no active generation) */}
              {!ai.streamedText && !ai.generating && savedAiResults && savedAiResults.length > 1 && (
                <CustomSelect
                  value={viewingSavedResult?.templateId ?? ""}
                  onChange={(v) => {
                    const r = savedAiResults.find((r) => r.templateId === v);
                    if (r) setViewingSavedResult(r);
                  }}
                  options={savedAiResults.map((r) => ({
                    value: r.templateId,
                    label: r.templateName,
                  }))}
                  className="mb-2"
                />
              )}
              {(ai.streamedText || viewingSavedResult?.content) ? (
                <div className="prose prose-invert max-w-none leading-relaxed">
                  <ReactMarkdown>{ai.streamedText || viewingSavedResult?.content || ""}</ReactMarkdown>
                </div>
              ) : ai.generating ? (
                <p className="text-[var(--color-text-muted)] text-sm">
                  Genererar...
                </p>
              ) : null}
              {ai.error && (
                <p className="text-[var(--color-error)] text-sm">
                  {ai.error}
                </p>
              )}
            </div>
          ) : viewMode === "transcription" ? (
            mdContent !== null && (
              <div>{renderMarkdown(mdContent)}</div>
            )
          ) : (
            /* Segment view */
            <div className="space-y-2">
              {segments.map((seg, i) => (
                <div
                  key={i}
                  className="p-3 rounded-lg glass hover:bg-white/[0.03] transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    {showTimestamps && (
                      <span className="text-xs text-[var(--color-text-muted)] font-mono">
                        [{formatTimestamp(seg.start)}]
                      </span>
                    )}
                    {seg.speaker_label && (
                      <span
                        className="text-xs font-semibold"
                        style={{
                          color:
                            speakerColors.get(seg.speaker_id ?? "unknown") ??
                            "var(--color-primary)",
                        }}
                      >
                        {seg.speaker_label}
                      </span>
                    )}
                  </div>
                  <p className="leading-relaxed">{seg.text}</p>
                </div>
              ))}
              {segments.length === 0 && (
                <p className="text-[var(--color-text-muted)] text-sm">
                  Segmentdata inte tillgänglig.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="w-72 border-l border-white/5 overflow-y-auto p-4 space-y-5 shrink-0">
          {/* View mode toggle */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
              Visningsläge
            </p>
            <div className="flex rounded-lg overflow-hidden glass">
              <button
                onClick={() => {
                  setViewMode("transcription");
                  setContentView("transcription");
                }}
                className={`flex-1 px-3 py-1.5 text-xs transition-colors ${
                  viewMode === "transcription" && contentView === "transcription"
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                }`}
              >
                Transkribering
              </button>
              <button
                onClick={() => {
                  setViewMode("segment");
                  setContentView("transcription");
                }}
                disabled={!hasSegments}
                className={`flex-1 px-3 py-1.5 text-xs transition-colors ${
                  viewMode === "segment" && contentView === "transcription"
                    ? "bg-[var(--color-primary)] text-white"
                    : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                } disabled:opacity-30 disabled:cursor-not-allowed`}
              >
                Segment
              </button>
            </div>
            {contentView === "ai" && (
              <button
                onClick={() => setContentView("transcription")}
                className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs glass hover:bg-white/5 transition-colors text-[var(--color-text-muted)]"
              >
                Visa transkribering
              </button>
            )}
            {(ai.streamedText || (savedAiResults && savedAiResults.length > 0)) && contentView === "transcription" && (
              <button
                onClick={() => setContentView("ai")}
                className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs glass hover:bg-white/5 transition-colors text-[var(--color-text-muted)]"
              >
                Visa bearbetning
              </button>
            )}
          </div>

          {/* Save / Copy */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
              Spara
            </p>
            <div className="space-y-1.5">
              {mdContent && (
                <button
                  onClick={handleSaveAs}
                  disabled={saving}
                  className="w-full px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] text-xs transition-all disabled:opacity-50 hover:shadow-[0_0_20px_rgba(37,99,235,0.25)]"
                >
                  {saving ? "Sparar..." : "Spara som\u2026"}
                </button>
              )}
              {(mdContent || ai.streamedText || viewingSavedResult?.content) && (
                <button
                  onClick={handleSaveDocx}
                  disabled={saving}
                  className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
                >
                  {saving ? "Sparar..." : "Spara som Word\u2026"}
                </button>
              )}
              {(mdContent || ai.streamedText) && (
                <button
                  onClick={handleCopy}
                  className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
                >
                  {copied ? "Kopierat!" : "Kopiera text"}
                </button>
              )}
            </div>
          </div>

          {/* Options */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
              Val
            </p>
            <div className="space-y-3">
              {/* Font size */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-[var(--color-text-muted)]">Textstorlek</span>
                  <span className="text-xs text-[var(--color-text-muted)]">{fontSize}px</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-[var(--color-text-muted)]">A</span>
                  <input
                    type="range"
                    min={10}
                    max={24}
                    value={fontSize}
                    onChange={(e) => setFontSize(Number(e.target.value))}
                    className="result-range flex-1"
                  />
                  <span className="text-lg text-[var(--color-text-muted)]">A</span>
                </div>
              </div>
              {/* Timestamps toggle */}
              {hasSegments && (
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs text-[var(--color-text-muted)]">
                    Visa tidsmarkering
                  </span>
                  <div
                    onClick={() => setShowTimestamps(!showTimestamps)}
                    className={`w-9 h-5 rounded-full transition-colors cursor-pointer flex items-center ${
                      showTimestamps
                        ? "bg-[var(--color-primary)]"
                        : "bg-white/10"
                    }`}
                  >
                    <div
                      className={`w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform ${
                        showTimestamps ? "translate-x-[18px]" : "translate-x-[3px]"
                      }`}
                    />
                  </div>
                </label>
              )}
            </div>
          </div>

          {/* Re-transcribe */}
          {onRetranscribe && (
            <div>
              <button
                onClick={onRetranscribe}
                className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
              >
                Transkribera igen
              </button>
            </div>
          )}

          {/* AI section */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
              Bearbeta transkribering
            </p>

            {!ai.isReady ? (
              <div className="p-3 rounded-lg glass text-xs text-[var(--color-text-muted)] space-y-1">
                <p>AI-bearbetning är inte aktiverad.</p>
                <p>Välj leverantör, API-nyckel och modell under Inställningar → AI-bearbetning.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Prompt template */}
                <div>
                  <label className="text-xs text-[var(--color-text-muted)] block mb-1">
                    Välj prompt
                  </label>
                  <CustomSelect
                    value={selectedTemplate.id}
                    onChange={(v) => {
                      const t = allTemplates.find((t) => t.id === v);
                      if (t) setSelectedTemplate(t);
                    }}
                    options={allTemplates.map((t) => ({
                      value: t.id,
                      label: t.name,
                    }))}
                  />
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    {selectedTemplate.description}
                  </p>
                </div>

                {/* Custom prompt */}
                {selectedTemplate.isCustom && (
                  <textarea
                    value={customPrompt}
                    onChange={(e) => setCustomPrompt(e.target.value)}
                    placeholder="Skriv din instruktion..."
                    rows={3}
                    className="w-full px-2 py-1.5 rounded-lg glass-input text-xs bg-transparent text-[var(--color-text)] resize-none"
                  />
                )}

                {/* Extra context */}
                <div>
                  <button
                    onClick={() => setShowContext(!showContext)}
                    className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors flex items-center gap-1"
                  >
                    <svg
                      className={`w-3 h-3 transition-transform ${showContext ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                    Lägg till information
                  </button>
                  {showContext && (
                    <textarea
                      value={extraContext}
                      onChange={(e) => setExtraContext(e.target.value)}
                      placeholder="T.ex. dagordning, namn på deltagare..."
                      rows={3}
                      className="w-full mt-1 px-2 py-1.5 rounded-lg glass-input text-xs bg-transparent text-[var(--color-text)] resize-none"
                    />
                  )}
                </div>

                {/* Provider info */}
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  {ai.preset.name} · {ai.current.model}
                  <br />
                  Texten skickas till {hostOf(ai.current.baseUrl)} när du klickar på Bearbeta. Ljud skickas aldrig.
                </p>

                {/* Generate / Cancel button */}
                {ai.generating ? (
                  <button
                    onClick={() => ai.cancel()}
                    className="w-full px-3 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 text-xs transition-all hover:shadow-[0_0_20px_rgba(220,38,38,0.25)] flex items-center justify-center gap-2"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />
                    </svg>
                    Avbryt
                  </button>
                ) : (
                  <button
                    onClick={handleGenerate}
                    disabled={
                      !mdContent ||
                      (selectedTemplate.isCustom && !customPrompt.trim())
                    }
                    className="w-full px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] text-xs transition-all disabled:opacity-50 hover:shadow-[0_0_20px_rgba(37,99,235,0.25)] flex items-center justify-center gap-2"
                  >
                    Bearbeta
                  </button>
                )}
              </div>
            )}
          </div>

          {/* New transcription */}
          <div className="pt-2 border-t border-white/5">
            <button
              onClick={onBack}
              className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
            >
              Ny transkribering
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
