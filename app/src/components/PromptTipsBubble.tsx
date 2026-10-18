import { useEffect, useRef, useState } from "react";

const SEEN_KEY = "motesskribent-prompt-tips-seen";

interface Tip {
  title: string;
  text: string;
  worse?: string;
  better?: string;
}

const TIPS: Tip[] = [
  {
    title: "Ge AI:n en roll",
    text: "Börja med vem AI:n ska vara. Det styr ton, ordval och vad som anses viktigt.",
    worse: "Sammanfatta mötet.",
    better: "Du är en erfaren nämndsekreterare i en svensk kommun.",
  },
  {
    title: "Säg exakt vad du vill ha",
    text: "Beskriv uppgiften och målgruppen. Vem ska läsa resultatet, och vad ska de kunna göra med det?",
    worse: "Gör något bra av det här.",
    better: "Skriv en sammanfattning som chefer som inte var med kan läsa på två minuter.",
  },
  {
    title: "Bestäm formatet",
    text: "Ange rubriker, punktlistor, tabeller eller längd. Annars väljer AI:n själv.",
    worse: "Lista besluten.",
    better: "Lista besluten i en tabell med kolumnerna Beslut, Ansvarig och Datum.",
  },
  {
    title: "Sätt gränser",
    text: "Tala om vad AI:n inte ska göra. Det minskar risken för påhittade uppgifter.",
    better: "Hitta inte på namn eller datum. Skriv ”Framgår inte” om något saknas i transkriptet.",
  },
  {
    title: "Dela upp i steg",
    text: "En numrerad lista med steg ger mer förutsägbara resultat än en lång mening.",
    better: "1. Identifiera mötets ämnen. 2. Sammanfatta varje ämne i 2–3 meningar. 3. Lista öppna frågor.",
  },
  {
    title: "Tänk på talarna",
    text: "Transkriptet märker röster som Talare 1, Talare 2 osv. Be AI:n behålla dem, eller fyll i riktiga namn som extra kontext i resultatvyn.",
  },
  {
    title: "Testa och justera",
    text: "Kör mallen på ett riktigt möte och ändra en sak i taget. Små formuleringsändringar kan ge stor skillnad.",
  },
];

/**
 * Tipsknapp med en pratbubbla om hur man formulerar bra promptmallar.
 * `onInsertSkeleton` lägger in en färdig stomme i redigeraren, om en mall är öppen.
 */
export default function PromptTipsBubble({ onInsertSkeleton }: { onInsertSkeleton?: () => void }) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => {
    try { return localStorage.getItem(SEEN_KEY) === "true"; } catch { return true; }
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const toggle = () => {
    setOpen((v) => !v);
    if (!seen) {
      setSeen(true);
      try { localStorage.setItem(SEEN_KEY, "true"); } catch {}
    }
  };

  return (
    <div ref={rootRef} className="relative">
      {open && (
        <div
          role="dialog"
          aria-label="Prompttips"
          className="absolute right-0 top-full mt-3 z-40 w-[min(26rem,calc(100vw-3rem))] max-h-[70vh] flex flex-col rounded-2xl border border-white/10 bg-[var(--color-surface)] shadow-2xl animate-fade-in"
        >
          <div className="flex items-start gap-3 px-4 pt-4 pb-3 border-b border-white/10">
            <div className="w-8 h-8 shrink-0 rounded-full bg-amber-400/15 text-amber-300 flex items-center justify-center">
              <BulbIcon className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold">Tips för bra promptmallar</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                En bra mall är som en tydlig beställning till en kollega.
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              aria-label="Stäng tips"
              className="w-7 h-7 rounded-full flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5"
            >
              ✕
            </button>
          </div>

          <ol className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {TIPS.map((tip, i) => (
              <li key={tip.title} className="flex gap-3">
                <span className="w-5 h-5 shrink-0 mt-0.5 rounded-full bg-[var(--color-primary)]/20 text-[var(--color-primary-hover)] text-[11px] font-semibold flex items-center justify-center">
                  {i + 1}
                </span>
                <div className="min-w-0 space-y-1.5">
                  <p className="text-sm font-medium">{tip.title}</p>
                  <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{tip.text}</p>
                  {tip.worse && (
                    <p className="text-xs rounded-md px-2 py-1 bg-red-500/10 text-red-300">
                      <span className="font-semibold">Sämre: </span>{tip.worse}
                    </p>
                  )}
                  {tip.better && (
                    <p className="text-xs rounded-md px-2 py-1 bg-emerald-500/10 text-emerald-300">
                      <span className="font-semibold">Bättre: </span>{tip.better}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>

          <div className="px-4 py-3 border-t border-white/10 flex items-center gap-2">
            <p className="flex-1 text-[11px] text-[var(--color-text-muted)]">
              Transkriptet läggs alltid till automatiskt – du behöver inte klistra in det.
            </p>
            {onInsertSkeleton && (
              <button
                onClick={() => { onInsertSkeleton(); setOpen(false); }}
                className="shrink-0 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-xs transition-colors"
              >
                Infoga stomme
              </button>
            )}
          </div>

          {/* Pratbubblans spets */}
          <span className="absolute -top-1.5 right-6 w-3 h-3 rotate-45 bg-[var(--color-surface)] border-l border-t border-white/10" />
        </div>
      )}

      <button
        onClick={toggle}
        aria-expanded={open}
        aria-label={open ? "Dölj prompttips" : "Visa prompttips"}
        className="relative flex items-center gap-1.5 pl-2.5 pr-3 h-8 rounded-full bg-amber-400 text-slate-900 text-xs font-semibold hover:bg-amber-300 transition-colors"
      >
        <BulbIcon className="w-4 h-4" />
        Prompttips
        {!seen && (
          <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-[var(--color-primary)] ring-2 ring-[var(--color-bg)]" />
        )}
      </button>
    </div>
  );
}

function BulbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 18h6M10 21h4M12 3a6 6 0 00-3.6 10.8c.4.3.6.8.6 1.3V16h6v-.9c0-.5.2-1 .6-1.3A6 6 0 0012 3z"
      />
    </svg>
  );
}
