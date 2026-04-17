import Logo from "./Logo";
import type { OllamaStatus } from "../hooks/useOllama";

interface Props {
  onNavigate: (view: "recording" | "transcribe" | "history" | "settings") => void;
  sidecarReady: boolean;
  onInfoClick: () => void;
  ollamaStatus: OllamaStatus;
}

const CARDS = [
  {
    id: "recording" as const,
    title: "Spela in",
    desc: "Spela in ljud direkt med mikrofonen",
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
        />
      </svg>
    ),
  },
  {
    id: "history" as const,
    title: "Transkriptioner",
    desc: "Visa tidigare transkriptioner",
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    id: "settings" as const,
    title: "Inställningar",
    desc: "Konfigurera modell, format och mer",
    icon: (
      <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z"
        />
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
        />
      </svg>
    ),
  },
];

export default function DashboardView({ onNavigate, sidecarReady, onInfoClick, ollamaStatus }: Props) {
  return (
    <div className="flex flex-col items-center justify-center min-h-full py-8 animate-fade-in">
      {/* Logo + title */}
      <div className="flex flex-col items-center gap-3 mb-10">
        <Logo size={64} />
        <h1 className="text-3xl font-bold tracking-tight">MötesSkribent</h1>
        <p className="text-[var(--color-text-muted)] text-sm max-w-lg text-center leading-relaxed mt-1">
          Omvandla dina mötesinspelningar till tydliga mötesprotokoll — helt lokalt på din dator.
          Klicka på spela in och låt Möteskribenten ta dina anteckningar och låt en lokal AI-modell bearbeta dem.
          Fungerar för både digitala och fysiska möten. Ingen data lämnar din maskin.
        </p>
      </div>

      {/* Action cards */}
      <div className="flex flex-wrap justify-center gap-4 max-w-2xl w-full px-4">
        {CARDS.map((card) => (
          <button
            key={card.id}
            onClick={() => onNavigate(card.id)}
            className="glass rounded-xl p-6 flex flex-col items-center gap-3 w-48 text-center transition-all duration-200 hover:scale-[1.02] hover:border-[rgba(255,255,255,0.18)] hover:shadow-[0_0_24px_rgba(37,99,235,0.15)]"
          >
            <div className="text-[var(--color-primary)]">{card.icon}</div>
            <h3 className="text-sm font-semibold">{card.title}</h3>
            <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
              {card.desc}
            </p>
          </button>
        ))}
      </div>

      {/* Feedback */}
      <div className="flex items-center gap-2 mt-8 text-xs text-[var(--color-text-muted)]">
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
          />
        </svg>
        <span>Har du synpunkter eller förslag?</span>
        <a
          href="mailto:Erik Nunez Astorga <erik.nunez.astorga@vasteras.se>?subject=Feedback%20-%20M%C3%B6tesSkribent"
          className="text-[var(--color-primary)] hover:underline"
        >
          Skicka feedback
        </a>
      </div>

      {/* Status indicators */}
      <div className="flex flex-col items-center gap-2 mt-8">
        {!sidecarReady && (
          <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
            <div className="w-3 h-3 border-2 border-[var(--color-primary)] border-t-transparent rounded-full animate-spin" />
            <span>AI-motor startar...</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
          {ollamaStatus.available === null ? (
            <>
              <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
              <span>Kontrollerar Ollama...</span>
            </>
          ) : ollamaStatus.available ? (
            <>
              <div className="w-2 h-2 rounded-full bg-green-400" />
              <span>Ollama aktiv ({ollamaStatus.models.length} {ollamaStatus.models.length === 1 ? "modell" : "modeller"})</span>
            </>
          ) : (
            <>
              <div className="w-2 h-2 rounded-full bg-gray-500" />
              <span>Ollama ej ansluten</span>
            </>
          )}
        </div>
      </div>

      {/* Info button */}
      <button
        onClick={onInfoClick}
        className="fixed bottom-5 right-5 w-9 h-9 rounded-full glass flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-[rgba(255,255,255,0.18)] transition-all"
        title="Information"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
      </button>
    </div>
  );
}
