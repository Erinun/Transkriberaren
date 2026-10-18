import { useId, useState, type ReactNode } from "react";

/** Kort med rubrik och en mening om vad avsnittet handlar om. */
export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="glass rounded-xl p-5 space-y-5">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Etikett med en frågeknapp. Klick på "?" fäller ut en förklaring i klartext,
 * så att den som inte kan begreppen förstår vad inställningen gör.
 */
export function HelpLabel({
  label,
  help,
  aside,
}: {
  label: string;
  help: ReactNode;
  /** Valfritt innehåll till höger, t.ex. ett värde eller en länkknapp. */
  aside?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{label}</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? `Dölj förklaring om ${label}` : `Vad betyder ${label}?`}
          title={open ? "Dölj förklaring" : "Vad betyder det här?"}
          className={`w-5 h-5 rounded-full text-[11px] font-semibold flex items-center justify-center border transition-colors ${
            open
              ? "bg-[var(--color-primary)] border-[var(--color-primary)] text-white"
              : "border-white/20 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:border-white/40"
          }`}
        >
          ?
        </button>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {open && (
        <div
          id={panelId}
          className="p-3 rounded-lg text-xs leading-relaxed bg-[var(--color-primary)]/10 border border-[var(--color-primary)]/20 text-[var(--color-text)] space-y-1.5 animate-fade-in"
        >
          {help}
        </div>
      )}
    </div>
  );
}

/** Kort hjälptext under en kontroll. */
export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-xs text-[var(--color-text-muted)]">{children}</p>;
}

/** Hopfällbar del för inställningar som de flesta aldrig behöver ändra. */
export function Advanced({ title = "Avancerat", children }: { title?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-white/10 pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
      >
        <svg
          className={`w-4 h-4 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        {title}
        <span className="text-[11px]">(behöver oftast inte ändras)</span>
      </button>
      {open && <div className="mt-4 space-y-5">{children}</div>}
    </div>
  );
}
