import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePromptTemplates } from "../hooks/usePromptTemplates";
import { PROMPT_TEMPLATES, buildPrompt, estimateTokenCount, type PromptTemplate } from "../data/promptTemplates";
import { HelpLabel } from "./SettingsParts";
import PromptTipsBubble from "./PromptTipsBubble";

const NEW_ID = "__new__";

type Draft = Pick<PromptTemplate, "name" | "description" | "template">;

const EMPTY_DRAFT: Draft = { name: "", description: "", template: "" };

const SKELETON = `Du är en [roll, t.ex. erfaren mötessekreterare].

Uppgift:
[Vad ska AI:n göra med transkriptet?]

Målgrupp:
[Vem ska läsa resultatet och vad ska de kunna göra med det?]

Format:
- [Rubriker, punktlistor, tabell, ungefärlig längd …]

Gränser:
- Hitta inte på uppgifter som inte finns i transkriptet.
- Skriv ”Framgår inte” om något saknas.`;

const SAMPLE_TRANSCRIPT = "Talare 1: Då börjar vi. Första punkten är budgeten för hösten.\nTalare 2: Jag föreslår att vi skjuter beslutet till nästa möte.";

const PLACEHOLDERS = [
  {
    token: "{transcription}",
    label: "Transkript",
    what: "Byts ut mot hela transkriptet från mötet.",
    without: "Transkriptet läggs sist i prompten, efter din instruktion.",
    when: "Du vill ha instruktioner både före och efter transkriptet, t.ex. en påminnelse om formatet på slutet.",
  },
  {
    token: "{context}",
    label: "Extra kontext",
    what: "Byts ut mot det du skriver i rutan ”Extra kontext” i resultatvyn, t.ex. deltagarnas namn eller mötets syfte.",
    without: "Kontexten läggs precis före transkriptet. Är rutan tom försvinner den helt.",
    when: "Kontexten ska stå på ett bestämt ställe, t.ex. direkt efter rollbeskrivningen.",
  },
];

const sameDraft = (a: Draft, b: Draft) =>
  a.name === b.name && a.description === b.description && a.template === b.template;

/** Lista med mallar till vänster och en redigerare till höger, plus en tipsbubbla. */
export default function PromptTemplateManager() {
  const promptHook = usePromptTemplates();
  const editableTemplates = promptHook.templates.filter((t) => !t.isCustom);
  const builtIns = editableTemplates.filter((t) => PROMPT_TEMPLATES.some((b) => b.id === t.id));
  const userTemplates = editableTemplates.filter((t) => promptHook.isUserTemplate(t.id));

  const [selectedId, setSelectedId] = useState<string | null>(() => editableTemplates[0]?.id ?? null);
  const [draft, setDraft] = useState<Draft>(() => toDraft(editableTemplates[0]));
  const [baseline, setBaseline] = useState<Draft>(() => toDraft(editableTemplates[0]));
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  const isNew = selectedId === NEW_ID;
  const selected = isNew ? undefined : editableTemplates.find((t) => t.id === selectedId);
  const isUser = !!selected && promptHook.isUserTemplate(selected.id);
  const overridden = !!selected && !isUser && promptHook.isOverridden(selected.id);
  const dirty = !sameDraft(draft, baseline);
  const canSave = draft.name.trim() !== "" && draft.template.trim() !== "" && (dirty || isNew);

  const open = (id: string | null, initial?: Draft) => {
    const t = editableTemplates.find((x) => x.id === id);
    const next = initial ?? toDraft(t);
    setSelectedId(id);
    setDraft(next);
    setBaseline(id === NEW_ID ? EMPTY_DRAFT : next);
    setConfirmDelete(false);
    setShowPreview(false);
    setPendingAction(null);
  };

  /** Byter mall – men frågar först om det finns osparade ändringar. */
  const guarded = (action: () => void) => {
    if (dirty) setPendingAction(() => action);
    else action();
  };

  const flash = () => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1800);
  };

  const save = () => {
    if (!canSave) return false;
    const clean: Draft = { name: draft.name.trim(), description: draft.description.trim(), template: draft.template };
    if (isNew) {
      const id = promptHook.createTemplate(clean);
      setSelectedId(id);
    } else if (selected) {
      if (isUser) promptHook.updateUserTemplate(selected.id, clean);
      else promptHook.updateBuiltIn(selected.id, clean);
    }
    setDraft(clean);
    setBaseline(clean);
    flash();
    return true;
  };

  const startNew = (initial: Draft = EMPTY_DRAFT) => guarded(() => open(NEW_ID, initial));

  const duplicate = (t: Draft) =>
    startNew({ name: `${t.name} (kopia)`, description: t.description, template: t.template });

  const remove = () => {
    if (!selected || !isUser) return;
    promptHook.deleteTemplate(selected.id);
    const first = builtIns[0];
    open(first?.id ?? null);
  };

  const reset = () => {
    if (!selected) return;
    promptHook.resetBuiltIn(selected.id);
    const original = toDraft(PROMPT_TEMPLATES.find((b) => b.id === selected.id));
    setDraft(original);
    setBaseline(original);
  };

  const insertAtCursor = (text: string) => {
    const el = textareaRef.current;
    if (!el) {
      setDraft((d) => ({ ...d, template: d.template + text }));
      return;
    }
    const start = el.selectionStart ?? draft.template.length;
    const end = el.selectionEnd ?? start;
    const next = draft.template.slice(0, start) + text + draft.template.slice(end);
    setDraft((d) => ({ ...d, template: next }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const insertSkeleton = () => {
    if (!selectedId) {
      startNew({ ...EMPTY_DRAFT, template: SKELETON });
      return;
    }
    setDraft((d) => ({ ...d, template: d.template.trim() ? `${d.template.trimEnd()}\n\n${SKELETON}` : SKELETON }));
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const charCount = draft.template.length;
  const preview = showPreview
    ? buildPrompt({ id: "preview", ...draft }, SAMPLE_TRANSCRIPT, "Mötet gäller kulturnämnden.")
    : "";

  return (
    <>
      <HelpLabel
        label="Vad är en promptmall?"
        aside={<PromptTipsBubble onInsertSkeleton={insertSkeleton} />}
        help={
          <>
            <p>
              En prompt är instruktionen som AI:n får tillsammans med transkriptet – ungefär som när du
              ber en kollega ”sammanfatta det här mötet i fem punkter”. En mall sparar en sådan
              instruktion så att du kan återanvända den med ett klick.
            </p>
            <p>
              Du kan redigera de inbyggda mallarna (och återställa dem) eller skapa egna. Transkriptet
              läggs alltid till automatiskt. Mallarna används bara om AI-bearbetning är aktiverad.
            </p>
          </>
        }
      />

      <div className="grid lg:grid-cols-[17rem_minmax(0,1fr)] gap-4 items-start">
        {/* Mallista */}
        <aside className="space-y-4">
          <button
            onClick={() => startNew()}
            className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isNew
                ? "bg-[var(--color-primary)]/20 text-[var(--color-text)] border border-[var(--color-primary)]/50"
                : "bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white"
            }`}
          >
            <span className="text-base leading-none">+</span> Ny promptmall
          </button>

          <TemplateGroup title="Mina mallar" count={userTemplates.length}>
            {userTemplates.length === 0 ? (
              <p className="px-3 py-3 text-xs text-[var(--color-text-muted)] rounded-lg border border-dashed border-white/10">
                Du har inga egna mallar än. Skapa en ny eller duplicera en inbyggd mall och anpassa den.
              </p>
            ) : (
              userTemplates.map((t) => (
                <TemplateItem
                  key={t.id}
                  template={t}
                  active={t.id === selectedId}
                  badge={<Badge tone="green">Egen</Badge>}
                  onClick={() => t.id !== selectedId && guarded(() => open(t.id))}
                />
              ))
            )}
          </TemplateGroup>

          <TemplateGroup title="Inbyggda mallar" count={builtIns.length}>
            {builtIns.map((t) => (
              <TemplateItem
                key={t.id}
                template={t}
                active={t.id === selectedId}
                badge={promptHook.isOverridden(t.id) ? <Badge tone="blue">Anpassad</Badge> : null}
                onClick={() => t.id !== selectedId && guarded(() => open(t.id))}
              />
            ))}
          </TemplateGroup>
        </aside>

        {/* Redigerare */}
        <div
          className="rounded-xl border border-white/10 bg-black/15 min-w-0"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              save();
            }
          }}
        >
          {!selectedId ? (
            <div className="p-10 text-center space-y-2">
              <p className="text-sm font-medium">Välj en mall i listan</p>
              <p className="text-xs text-[var(--color-text-muted)]">eller skapa en ny för att komma igång.</p>
            </div>
          ) : (
            <>
              {/* Rubrikrad */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-4 border-b border-white/10">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-base font-semibold truncate">
                      {isNew ? "Ny promptmall" : draft.name || "Namnlös mall"}
                    </h4>
                    {isUser && <Badge tone="green">Egen</Badge>}
                    {!isNew && !isUser && <Badge tone="muted">Inbyggd</Badge>}
                    {overridden && <Badge tone="blue">Anpassad</Badge>}
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {dirty ? (
                      <span className="text-[var(--color-warning)]">● Osparade ändringar</span>
                    ) : savedFlash ? (
                      <span className="text-[var(--color-success)]">✓ Sparad</span>
                    ) : isNew ? (
                      "Fyll i namn och instruktion och klicka på Skapa."
                    ) : (
                      "Visas som ett val under ”Bearbeta transkribering” i resultatvyn."
                    )}
                  </p>
                </div>
                {!isNew && (
                  <div className="flex items-center gap-1.5">
                    <GhostButton onClick={() => duplicate(draft)} title="Skapa en egen kopia av mallen">
                      Duplicera
                    </GhostButton>
                    {overridden && (
                      <GhostButton onClick={reset} title="Återställ till appens ursprungliga text">
                        Återställ original
                      </GhostButton>
                    )}
                    {isUser &&
                      (confirmDelete ? (
                        <span className="flex items-center gap-1.5">
                          <span className="text-xs text-red-300">Ta bort?</span>
                          <button
                            onClick={remove}
                            className="px-2.5 py-1 rounded-md text-xs bg-red-500/80 hover:bg-red-500 text-white"
                          >
                            Ja, ta bort
                          </button>
                          <GhostButton onClick={() => setConfirmDelete(false)}>Nej</GhostButton>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmDelete(true)}
                          className="px-2.5 py-1 rounded-md text-xs border border-red-500/30 text-red-300 hover:bg-red-500/10 transition-colors"
                        >
                          Ta bort
                        </button>
                      ))}
                  </div>
                )}
              </div>

              {pendingAction && (
                <div className="mx-5 mt-4 flex flex-wrap items-center gap-2 px-3 py-2.5 rounded-lg bg-amber-400/10 border border-amber-400/30 text-sm">
                  <span className="flex-1 min-w-[12rem]">Du har osparade ändringar i den här mallen.</span>
                  <button
                    onClick={() => { if (save()) pendingAction(); }}
                    disabled={!canSave}
                    className="px-2.5 py-1 rounded-md text-xs bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white disabled:opacity-50"
                  >
                    Spara och fortsätt
                  </button>
                  <GhostButton onClick={() => pendingAction()}>Släng ändringar</GhostButton>
                  <GhostButton onClick={() => setPendingAction(null)}>Stanna kvar</GhostButton>
                </div>
              )}

              <div className="p-5 space-y-5">
                {isNew && !draft.template && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
                      Börja från
                    </p>
                    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-2">
                      <StarterCard
                        title="Färdig stomme"
                        text="Roll, uppgift, målgrupp, format och gränser – fyll bara i hakparenteserna."
                        onClick={() => setDraft((d) => ({ ...d, template: SKELETON }))}
                        highlight
                      />
                      {builtIns.map((t) => (
                        <StarterCard
                          key={t.id}
                          title={t.name}
                          text={`Utgå från den inbyggda mallen: ${t.description.toLowerCase()}.`}
                          onClick={() =>
                            setDraft((d) => ({
                              name: d.name || `${t.name} (egen)`,
                              description: d.description || t.description,
                              template: t.template,
                            }))
                          }
                        />
                      ))}
                    </div>
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      …eller skriv direkt i rutan nedan.
                    </p>
                  </div>
                )}

                <div className="grid md:grid-cols-2 gap-4">
                  <Field label="Namn" hint="Kort, så att mallen går lätt att hitta." required>
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      placeholder="T.ex. Beslutslogg för nämnd"
                      maxLength={60}
                      className="w-full px-3 py-2 rounded-lg glass-input text-sm"
                    />
                  </Field>
                  <Field label="Beskrivning" hint="Visas under namnet när du väljer mall.">
                    <input
                      value={draft.description}
                      onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                      placeholder="Vad mallen gör, i en mening"
                      maxLength={120}
                      className="w-full px-3 py-2 rounded-lg glass-input text-sm"
                    />
                  </Field>
                </div>

                <Field label="Instruktion till AI:n" required>
                  <div className="rounded-lg glass-input overflow-hidden focus-within:border-[var(--color-primary)] focus-within:shadow-[0_0_0_3px_rgba(37,99,235,0.25)]">
                    <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 border-b border-white/5 bg-white/[0.02]">
                      <span className="text-[11px] text-[var(--color-text-muted)] mr-1">Infoga:</span>
                      <button
                        type="button"
                        onClick={insertSkeleton}
                        className="px-2 py-0.5 rounded-md text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5 transition-colors"
                      >
                        + Stomme
                      </button>
                    </div>
                    <textarea
                      ref={textareaRef}
                      value={draft.template}
                      onChange={(e) => setDraft((d) => ({ ...d, template: e.target.value }))}
                      placeholder="Beskriv vad AI:n ska göra med transkriptet, t.ex. ”Du är mötessekreterare. Sammanfatta mötets viktigaste punkter och lista alla beslut med ansvarig person.”"
                      rows={14}
                      spellCheck
                      className="block w-full px-3 py-2.5 bg-transparent text-sm leading-relaxed resize-y min-h-[14rem] focus:outline-none"
                    />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 mt-1.5">
                    <p className="text-[11px] text-[var(--color-text-muted)]">
                      Transkriptet skickas med automatiskt – du behöver inte skriva något om det.
                    </p>
                    <p className="text-[11px] text-[var(--color-text-muted)] tabular-nums">
                      {charCount} tecken · ~{estimateTokenCount(draft.template)} tokens
                    </p>
                  </div>
                </Field>

                <PlaceholderSection template={draft.template} onInsert={insertAtCursor} />

                <div>
                  <button
                    type="button"
                    onClick={() => setShowPreview((v) => !v)}
                    aria-expanded={showPreview}
                    className="flex items-center gap-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
                  >
                    <svg
                      className={`w-3.5 h-3.5 transition-transform ${showPreview ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                    </svg>
                    Förhandsgranska vad AI:n får
                  </button>
                  {showPreview && (
                    <pre className="mt-2 p-3 rounded-lg bg-black/30 border border-white/5 text-xs leading-relaxed whitespace-pre-wrap text-[var(--color-text-muted)] max-h-72 overflow-y-auto animate-fade-in">
                      {preview}
                    </pre>
                  )}
                </div>
              </div>

              {/* Åtgärder */}
              <div className="flex flex-wrap items-center gap-2 px-5 py-3 border-t border-white/10 bg-white/[0.02] rounded-b-xl">
                <button
                  onClick={save}
                  disabled={!canSave}
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] text-white text-sm font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isNew ? "Skapa mall" : "Spara ändringar"}
                </button>
                {(dirty || isNew) && (
                  <button
                    onClick={() => (isNew ? open(builtIns[0]?.id ?? null) : setDraft(baseline))}
                    className="px-4 py-2 rounded-lg glass hover:bg-white/5 text-sm transition-colors"
                  >
                    {isNew ? "Avbryt" : "Ångra ändringar"}
                  </button>
                )}
                <span className="ml-auto text-[11px] text-[var(--color-text-muted)]">
                  {!draft.name.trim() || !draft.template.trim()
                    ? "Namn och instruktion behövs."
                    : "Tips: Ctrl+S sparar."}
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function toDraft(t?: PromptTemplate): Draft {
  return t ? { name: t.name, description: t.description, template: t.template } : EMPTY_DRAFT;
}

function TemplateGroup({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="px-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {title} <span className="opacity-60">({count})</span>
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function TemplateItem({
  template,
  active,
  badge,
  onClick,
}: {
  template: PromptTemplate;
  active: boolean;
  badge: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
        active
          ? "bg-[var(--color-primary)]/15 border-[var(--color-primary)]/40"
          : "border-transparent hover:bg-white/5"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`text-sm font-medium truncate ${active ? "" : "text-[var(--color-text)]/90"}`}>
          {template.name}
        </span>
        {badge}
      </span>
      {template.description && (
        <span className="block text-[11px] text-[var(--color-text-muted)] truncate mt-0.5">{template.description}</span>
      )}
    </button>
  );
}

function Badge({ tone, children }: { tone: "green" | "blue" | "muted"; children: ReactNode }) {
  const tones = {
    green: "bg-emerald-500/20 text-emerald-400",
    blue: "bg-[var(--color-primary)]/20 text-[var(--color-primary-hover)]",
    muted: "bg-white/10 text-[var(--color-text-muted)]",
  };
  return <span className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded ${tones[tone]}`}>{children}</span>;
}

function GhostButton({ onClick, title, children }: { onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="px-2.5 py-1 rounded-md text-xs border border-white/10 text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5 transition-colors"
    >
      {children}
    </button>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-sm font-medium">
        {label}
        {required && <span className="text-[var(--color-text-muted)] font-normal"> *</span>}
      </span>
      {children}
      {hint && <p className="text-[11px] text-[var(--color-text-muted)]">{hint}</p>}
    </div>
  );
}

function StarterCard({
  title,
  text,
  onClick,
  highlight,
}: {
  title: string;
  text: string;
  onClick: () => void;
  highlight?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left p-3 rounded-lg border transition-colors ${
        highlight
          ? "border-amber-400/40 bg-amber-400/10 hover:bg-amber-400/15"
          : "border-white/10 hover:bg-white/5"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-[11px] text-[var(--color-text-muted)] mt-0.5">{text}</span>
    </button>
  );
}

/** Hopfällbar del för platshållarna – valfria, för den som vill styra var texten hamnar. */
function PlaceholderSection({ template, onInsert }: { template: string; onInsert: (token: string) => void }) {
  const used = PLACEHOLDERS.filter((p) => template.includes(p.token));
  const [open, setOpen] = useState(used.length > 0);

  return (
    <div className="rounded-lg border border-white/10">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/[0.03] transition-colors rounded-lg"
      >
        <svg
          className={`w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)] transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium">Avancerat: styr var transkript och kontext hamnar</span>
          <span className="block text-[11px] text-[var(--color-text-muted)]">
            Valfritt – de flesta mallar fungerar utmärkt utan.
          </span>
        </span>
        {used.length > 0 && <Badge tone="blue">{used.length} används</Badge>}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 space-y-3 animate-fade-in">
          <div className="text-xs leading-relaxed text-[var(--color-text-muted)] space-y-1.5">
            <p>
              <b className="text-[var(--color-text)]">Hur fungerar det?</b> AI:n transkriberar inte – det har
              appen redan gjort på din dator. AI:n får din instruktion tillsammans med den färdiga texten.
            </p>
            <p>
              Använder du <b className="text-[var(--color-text)]">inga</b> platshållare bygger appen ihop
              prompten så här: din instruktion → extra kontext (om du skrivit någon) → transkriptet. Det räcker
              nästan alltid.
            </p>
            <p>
              Lägger du in en platshållare hamnar texten <b className="text-[var(--color-text)]">exakt där</b>{" "}
              du placerar den. Ställ markören i instruktionen och klicka på knappen under respektive platshållare.
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-2">
            {PLACEHOLDERS.map((p) => {
              const inUse = template.includes(p.token);
              return (
                <div key={p.token} className="rounded-lg bg-black/20 border border-white/5 p-3 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{p.label}</span>
                    <code className="px-1.5 py-0.5 rounded text-[11px] bg-[var(--color-primary)]/15 text-[var(--color-primary-hover)]">
                      {p.token}
                    </code>
                    {inUse && <span className="text-[11px] text-[var(--color-success)]">✓ I mallen</span>}
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{p.what}</p>
                  <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                    <b className="text-[var(--color-text)]">Utan den: </b>{p.without}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
                    <b className="text-[var(--color-text)]">Välj den när: </b>{p.when}
                  </p>
                  <button
                    type="button"
                    onClick={() => onInsert(p.token)}
                    className="px-2.5 py-1 rounded-md text-xs bg-[var(--color-primary)]/15 text-[var(--color-primary-hover)] hover:bg-[var(--color-primary)]/25 transition-colors"
                  >
                    Infoga {p.label.toLowerCase()} vid markören
                  </button>
                </div>
              );
            })}
          </div>

          <p className="text-[11px] text-[var(--color-text-muted)]">
            Osäker på resultatet? Öppna <i>Förhandsgranska vad AI:n får</i> nedan och se hur prompten blir.
          </p>
        </div>
      )}
    </div>
  );
}
