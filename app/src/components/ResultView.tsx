import { useState, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import ReactMarkdown from "react-markdown";
import { generateDocxBase64 } from "../lib/generateDocx";
import type { TranscriptionSegment } from "../hooks/usePipeline";
import type { OllamaResult } from "../hooks/useHistory";
import { useOllama, type OllamaStatus, type OllamaOptions } from "../hooks/useOllama";
import { usePromptTemplates } from "../hooks/usePromptTemplates";
import {
  buildPrompt,
  estimateTokenCount,
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
  wordCount: number;
  onRetranscribe?: () => void;
  ollamaStatus: OllamaStatus;
  onOllamaComplete?: (result: OllamaResult) => void;
  savedOllamaResults?: OllamaResult[];
}

type ViewMode = "transcription" | "segment";
type ContentView = "transcription" | "ollama";

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

function formatFileSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
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
  wordCount,
  onRetranscribe,
  ollamaStatus,
  onOllamaComplete,
  savedOllamaResults,
}: Props) {
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("transcription");
  const [contentView, setContentView] = useState<ContentView>(
    () => (savedOllamaResults && savedOllamaResults.length > 0) ? "ollama" : "transcription"
  );
  const [fontSize, setFontSize] = useState(14);
  const [showTimestamps, setShowTimestamps] = useState(true);

  // Saved ollama result viewing (for history entries)
  const [viewingSavedResult, setViewingSavedResult] = useState<OllamaResult | null>(
    () => savedOllamaResults?.[0] ?? null,
  );

  // Sync viewingSavedResult and contentView when switching between history entries
  useEffect(() => {
    const hasSaved = savedOllamaResults && savedOllamaResults.length > 0;
    setViewingSavedResult(hasSaved ? savedOllamaResults[0] : null);
    if (hasSaved) {
      setContentView("ollama");
    }
  }, [savedOllamaResults]);

  // Track generating→done transition to auto-save
  const wasGeneratingRef = useRef(false);

  // Ollama state
  const ollama = useOllama(ollamaStatus);
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
    if (ollama.generating) {
      wasGeneratingRef.current = true;
      generatingTemplateRef.current = selectedTemplate;
    } else if (wasGeneratingRef.current && ollama.streamedText && !ollama.error) {
      wasGeneratingRef.current = false;
      if (onOllamaComplete && ollama.selectedModel) {
        onOllamaComplete({
          templateId: generatingTemplateRef.current.id,
          templateName: generatingTemplateRef.current.name,
          ollamaModel: ollama.selectedModel,
          content: ollama.streamedText,
          generatedAt: new Date().toISOString(),
        });
      }
    }
  }, [ollama.generating]); // eslint-disable-line react-hooks/exhaustive-deps

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
      contentView === "ollama"
        ? (ollama.streamedText || viewingSavedResult?.content)
        : mdContent;
    if (!content) return;

    const defaultName =
      contentView === "ollama"
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
      contentView === "ollama" && (ollama.streamedText || viewingSavedResult?.content)
        ? (ollama.streamedText || viewingSavedResult?.content)
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
    let options: OllamaOptions | undefined;
    try {
      const raw = localStorage.getItem("motesskribent-ollama-options");
      if (raw) options = JSON.parse(raw);
    } catch {}
    ollama.generate(prompt, options);
    setContentView("ollama");
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
            <span>Modell: <span className="text-[var(--color-text)] font-medium">{extractModelShortName(modelName)}</span></span>
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
          {contentView === "ollama" ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 mb-4">
                <h3 className="text-sm font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
                  {ollama.streamedText
                    ? selectedTemplate.name
                    : viewingSavedResult?.templateName ?? selectedTemplate.name}
                </h3>
                {ollama.generating && (
                  <div className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-glow-pulse" />
                )}
              </div>
              {/* Saved result dropdown (when multiple saved and no active generation) */}
              {!ollama.streamedText && !ollama.generating && savedOllamaResults && savedOllamaResults.length > 1 && (
                <select
                  value={viewingSavedResult?.templateId ?? ""}
                  onChange={(e) => {
                    const r = savedOllamaResults.find((r) => r.templateId === e.target.value);
                    if (r) setViewingSavedResult(r);
                  }}
                  className="px-2 py-1 rounded-lg glass-input text-xs bg-transparent text-[var(--color-text)] mb-2"
                >
                  {savedOllamaResults.map((r) => (
                    <option key={r.templateId} value={r.templateId}>
                      {r.templateName}
                    </option>
                  ))}
                </select>
              )}
              {(ollama.streamedText || viewingSavedResult?.content) ? (
                <div className="prose prose-invert max-w-none leading-relaxed">
                  <ReactMarkdown>{ollama.streamedText || viewingSavedResult?.content || ""}</ReactMarkdown>
                </div>
              ) : ollama.generating ? (
                <p className="text-[var(--color-text-muted)] text-sm">
                  Genererar...
                </p>
              ) : null}
              {ollama.error && (
                <p className="text-[var(--color-error)] text-sm">
                  {ollama.error}
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
            {contentView === "ollama" && (
              <button
                onClick={() => setContentView("transcription")}
                className="mt-2 w-full px-3 py-1.5 rounded-lg text-xs glass hover:bg-white/5 transition-colors text-[var(--color-text-muted)]"
              >
                Visa transkribering
              </button>
            )}
            {(ollama.streamedText || (savedOllamaResults && savedOllamaResults.length > 0)) && contentView === "transcription" && (
              <button
                onClick={() => setContentView("ollama")}
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
              {(mdContent || ollama.streamedText || viewingSavedResult?.content) && (
                <button
                  onClick={handleSaveDocx}
                  disabled={saving}
                  className="w-full px-3 py-2 rounded-lg glass hover:bg-white/5 text-xs transition-colors"
                >
                  {saving ? "Sparar..." : "Spara som Word\u2026"}
                </button>
              )}
              {(mdContent || ollama.streamedText) && (
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

          {/* Ollama section */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-2">
              Bearbeta transkribering
            </p>

            {ollama.available === false ? (
              <div className="p-3 rounded-lg glass text-xs text-[var(--color-text-muted)] space-y-1">
                <p>Ollama inte tillgänglig.</p>
                <p>
                  Installera{" "}
                  <span className="text-[var(--color-primary)]">ollama.com</span>{" "}
                  och starta tjänsten.
                </p>
                <button
                  onClick={ollama.refreshModels}
                  className="mt-2 text-[var(--color-primary)] hover:underline"
                >
                  Försök igen
                </button>
              </div>
            ) : ollama.available === null ? (
              <p className="text-xs text-[var(--color-text-muted)]">
                Kontrollerar Ollama...
              </p>
            ) : (
              <div className="space-y-3">
                {/* Prompt template */}
                <div>
                  <label className="text-xs text-[var(--color-text-muted)] block mb-1">
                    Välj prompt
                  </label>
                  <select
                    value={selectedTemplate.id}
                    onChange={(e) => {
                      const t = allTemplates.find(
                        (t) => t.id === e.target.value,
                      );
                      if (t) setSelectedTemplate(t);
                    }}
                    className="w-full px-2 py-1.5 rounded-lg glass-input text-xs bg-transparent text-[var(--color-text)]"
                  >
                    {allTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
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

                {/* Model selector */}
                <div>
                  <label className="text-xs text-[var(--color-text-muted)] block mb-1">
                    LLM-modell
                  </label>
                  <select
                    value={ollama.selectedModel ?? ""}
                    onChange={(e) => ollama.selectModel(e.target.value)}
                    className="w-full px-2 py-1.5 rounded-lg glass-input text-xs bg-transparent text-[var(--color-text)]"
                  >
                    {ollama.models.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name} ({formatFileSize(m.size)})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Context window warning */}
                {mdContent && (() => {
                  const prompt = buildPrompt(
                    selectedTemplate,
                    mdContent,
                    extraContext,
                    selectedTemplate.isCustom ? customPrompt : undefined,
                  );
                  const estTokens = estimateTokenCount(prompt);
                  let numCtx = 8192;
                  let numPredict = 4096;
                  try {
                    const raw = localStorage.getItem("motesskribent-ollama-options");
                    if (raw) {
                      const parsed = JSON.parse(raw);
                      if (parsed.num_ctx) numCtx = parsed.num_ctx;
                      if (parsed.num_predict) numPredict = parsed.num_predict;
                    }
                  } catch {}

                  if (estTokens + numPredict > numCtx) {
                    return (
                      <div className="p-2 rounded-lg text-[10px] text-yellow-200 bg-yellow-500/10 border border-yellow-500/20">
                        Transkriberingen ar cirka {estTokens.toLocaleString("sv-SE")} tokens
                        men kontextfonstret ar {numCtx.toLocaleString("sv-SE")}.
                        Kontextfonstret hojs automatiskt, men det kan krava mer RAM.
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Generate / Cancel button */}
                {ollama.generating ? (
                  <button
                    onClick={() => ollama.cancel()}
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
                      !ollama.selectedModel ||
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
