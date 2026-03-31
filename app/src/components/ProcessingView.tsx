interface Props {
  stage: string;
  percent: number;
  message: string;
  isIndeterminate?: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  preprocessing: "Förbehandlar ljud",
  diarization: "Identifierar talare",
  transcription: "Transkriberar",
  formatting: "Formaterar output",
};

export default function ProcessingView({ stage, percent, message, isIndeterminate }: Props) {
  const label = STAGE_LABELS[stage] ?? message ?? "Startar...";

  return (
    <div className="max-w-md mx-auto mt-24 animate-fade-in">
      <div className="glass-elevated rounded-2xl p-8 space-y-8 text-center">
        {/* Spinner */}
        <div className="flex justify-center">
          <div
            className="w-16 h-16 rounded-full animate-spin"
            style={{
              border: "4px solid rgba(255,255,255,0.06)",
              borderTopColor: "var(--color-primary)",
              boxShadow: "0 0 20px rgba(37, 99, 235, 0.2)",
            }}
          />
        </div>

        {/* Stage label */}
        <div>
          <p className="text-lg font-medium">{label}</p>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {isIndeterminate ? "Bearbetar..." : `${percent}%`}
          </p>
        </div>

        {/* Progress bar */}
        <div className="w-full h-2 glass rounded-full overflow-hidden">
          {isIndeterminate ? (
            <div
              className="h-full rounded-full"
              style={{
                width: "40%",
                background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                boxShadow: "0 0 12px rgba(37, 99, 235, 0.4)",
                animation: "indeterminate-slide 1.5s ease-in-out infinite",
              }}
            />
          ) : (
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${percent}%`,
                background: "linear-gradient(90deg, #2563eb, #60a5fa)",
                boxShadow: "0 0 12px rgba(37, 99, 235, 0.4)",
              }}
            />
          )}
        </div>
      </div>

      <style>{`
        @keyframes indeterminate-slide {
          0% { margin-left: 0%; }
          50% { margin-left: 60%; }
          100% { margin-left: 0%; }
        }
      `}</style>
    </div>
  );
}
