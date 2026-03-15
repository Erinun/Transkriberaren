interface Props {
  stage: string;
  percent: number;
  message: string;
}

const STAGE_LABELS: Record<string, string> = {
  preprocessing: "Förbehandlar ljud",
  diarization: "Identifierar talare",
  transcription: "Transkriberar",
  formatting: "Formaterar output",
};

export default function ProcessingView({ stage, percent, message }: Props) {
  const label = STAGE_LABELS[stage] ?? message ?? "Startar...";

  return (
    <div className="max-w-md mx-auto mt-24 space-y-8 text-center">
      {/* Spinner */}
      <div className="flex justify-center">
        <div className="w-16 h-16 border-4 border-[var(--color-border)] border-t-[var(--color-primary)] rounded-full animate-spin" />
      </div>

      {/* Stage label */}
      <div>
        <p className="text-lg font-medium">{label}</p>
        <p className="text-sm text-[var(--color-text-muted)] mt-1">{percent}%</p>
      </div>

      {/* Progress bar */}
      <div className="w-full h-2 bg-[var(--color-surface)] rounded-full overflow-hidden">
        <div
          className="h-full bg-[var(--color-primary)] transition-all duration-500 ease-out rounded-full"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
