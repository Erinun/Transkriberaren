import { useEffect, useRef } from "react";
import { BERGET_CHAT_MODELS, formatMeetingHours, meetingHoursFor } from "../lib/aiProviders";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

/** Hur transkriptets text tar sig igenom appen, steg för steg. */
const DATA_FLOW = [
  {
    step: "1",
    title: "Ljudet stannar på datorn",
    body: "Taligenkänning och talaridentifiering körs lokalt med CPU. Inget ljud skickas någonstans.",
  },
  {
    step: "2",
    title: "Text till AI – bara om du vill",
    body: "AI-bearbetning är avstängd tills du slår på den. Startar du en bearbetning skickas transkriptets text och promptmallen till tjänsten du valt – aldrig ljudet.",
  },
  {
    step: "3",
    title: "Resultatet sparas lokalt",
    body: "Sammanfattningar och protokoll sparas tillsammans med transkriptionen på din dator.",
  },
];

/** Jämförelse av var texten hamnar beroende på vilken AI-tjänst man väljer. */
const COMPARISON_ROWS = [
  {
    label: "Var bearbetas texten?",
    berget: "På Bergets egna servrar i svenska datacenter.",
    cloud: "Ofta i USA, ibland i en EU-region beroende på avtal.",
    own: "Där servern står – på din dator eller i organisationens nät.",
  },
  {
    label: "Sparas texten?",
    berget: "Enligt Berget sparas varken frågor eller svar.",
    cloud: "Sparas ofta en tid, t.ex. 30 dagar för missbrukskontroll.",
    own: "Bestäms av dig eller organisationen.",
  },
  {
    label: "Tränas AI:n på texten?",
    berget: "Nej, enligt Berget.",
    cloud: "Normalt inte via API, men villkoren varierar.",
    own: "Nej.",
  },
  {
    label: "Vilken lag gäller?",
    berget: "Svenskt bolag – omfattas inte av amerikanska CLOUD Act.",
    cloud: "Amerikanska bolag kan omfattas av CLOUD Act, även med data i EU.",
    own: "Samma som för din dator eller organisation.",
  },
  {
    label: "Modeller",
    berget: "Öppna modeller som Berget själv kör, t.ex. Gemma, Mistral och Kimi.",
    cloud: "Tjänstens egna modeller, t.ex. GPT eller Gemini.",
    own: "De modeller du själv har installerat.",
  },
  {
    label: "Kostnad",
    berget: "Eget konto och API-nyckel, betalning efter användning.",
    cloud: "Eget konto och API-nyckel, betalning efter användning.",
    own: "Gratis att använda, men kräver kraftfull dator eller server.",
  },
];

const PRICE_STYLE: Record<string, string> = {
  Låg: "text-[var(--color-success)] bg-[var(--color-success)]/10",
  Medel: "text-[var(--color-warning)] bg-[var(--color-warning)]/10",
  Hög: "text-[var(--color-error)] bg-[var(--color-error)]/10",
};

const FACTS = [
  {
    title: "Taligenkänning",
    body: "Standardmotorn är Pianissimo, en svensk modell från Klang. KB-Whisper från Kungliga biblioteket finns som alternativ och tar över automatiskt om Pianissimo inte kan köras. Röstaktivitetsdetektering (VAD) filtrerar bort tystnad.",
  },
  {
    title: "Filformat och historik",
    body: "WAV, MP3, M4A, FLAC, OGG och WMA stöds. De 5 senaste transkriptionerna, med eventuella AI-resultat, sparas lokalt. Äldre tas bort automatiskt – använd Spara för att behålla viktiga resultat.",
  },
  {
    title: "Upphov och licenser",
    body: "Pianissimo (KlangAI/pianissimo-sv-onnx) är skapad av Klang under CC BY 4.0. KB-Whisper är skapad av KBLab. Taligenkänningen körs med onnx-asr och faster-whisper. Berget AI är en fristående tjänst med egna villkor.",
  },
];

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-primary)] mb-3">
      {children}
    </h3>
  );
}

export default function InfoModal({ isOpen, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.7)", backdropFilter: "blur(4px)" }}
      onClick={handleOverlayClick}
    >
      <div
        ref={panelRef}
        className="bg-[var(--color-surface)] border border-white/10 shadow-2xl shadow-black/60 rounded-2xl max-w-5xl w-full max-h-[90vh] overflow-y-auto p-6 md:p-8 animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <h2 className="text-xl font-semibold">Om MötesSkribent</h2>
            <p className="text-sm text-[var(--color-text-muted)] mt-1">
              Lokal mötestranskribering på svenska – med valfri AI-bearbetning från en tjänst du själv väljer.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-white/5 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Dataflöde */}
        <section className="mb-8">
          <SectionHeading>Så hanteras din information</SectionHeading>
          <div className="grid gap-3 md:grid-cols-3">
            {DATA_FLOW.map((item) => (
              <div key={item.step} className="rounded-xl bg-white/[0.05] border border-white/10 p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-6 h-6 rounded-full bg-[var(--color-primary)]/15 text-[var(--color-primary)] text-xs font-semibold flex items-center justify-center">
                    {item.step}
                  </span>
                  <h4 className="text-sm font-semibold">{item.title}</h4>
                </div>
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{item.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Jämförelse */}
        <section className="mb-8">
          <SectionHeading>Berget AI jämfört med andra AI-tjänster</SectionHeading>
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-4 max-w-3xl">
            AI-bearbetningen fungerar med alla tjänster som har ett OpenAI-kompatibelt gränssnitt. Berget AI är
            förvalt eftersom det är en svensk tjänst där mötestexten bearbetas i Sverige. Väljer du en annan
            tjänst under <b>Egen server</b> är det den tjänstens villkor som gäller för din text.
          </p>
          <div className="overflow-x-auto rounded-xl border border-white/5">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-white/[0.04] text-left">
                  <th className="p-3 font-medium text-[var(--color-text-muted)] w-[16%]"></th>
                  <th className="p-3 font-semibold text-[var(--color-primary)] w-[28%]">Berget AI (förvalt)</th>
                  <th className="p-3 font-semibold w-[28%]">Stora molntjänster (t.ex. OpenAI, Google)</th>
                  <th className="p-3 font-semibold w-[28%]">Egen server (t.ex. Ollama)</th>
                </tr>
              </thead>
              <tbody>
                {COMPARISON_ROWS.map((row) => (
                  <tr key={row.label} className="border-t border-white/5 align-top">
                    <td className="p-3 font-medium">{row.label}</td>
                    <td className="p-3 text-[var(--color-text-muted)] bg-[var(--color-primary)]/[0.04]">{row.berget}</td>
                    <td className="p-3 text-[var(--color-text-muted)]">{row.cloud}</td>
                    <td className="p-3 text-[var(--color-text-muted)]">{row.own}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[var(--color-text-muted)] mt-2 opacity-80">
            Uppgifterna om Berget kommer från Bergets egen beskrivning. Villkoren hos molntjänsterna varierar
            mellan tjänst och avtal – läs alltid tjänstens egna villkor.
          </p>
        </section>

        {/* Bergets modeller */}
        <section className="mb-8">
          <SectionHeading>Bergets modeller i appen</SectionHeading>
          <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-4 max-w-3xl">
            Du väljer modell i Inställningar. En billig modell räcker oftast för sammanfattningar och protokoll,
            medan större modeller ger mer genomarbetade texter men är långsammare och dyrare. Mötestiden visar
            ungefär hur långt möte modellen klarar att läsa in på en gång.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BERGET_CHAT_MODELS.map((m) => (
              <div key={m.id} className="rounded-xl bg-white/[0.05] border border-white/10 p-4">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <h4 className="text-sm font-semibold">
                    {m.name}
                    {m.preview && (
                      <span className="ml-1.5 text-[10px] font-normal text-[var(--color-text-muted)]">förhandsversion</span>
                    )}
                  </h4>
                  <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full shrink-0 ${PRICE_STYLE[m.price]}`}>
                    {m.price} kostnad
                  </span>
                </div>
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed mb-2">{m.description}</p>
                <p className="text-[11px] text-[var(--color-text-muted)] opacity-80">
                  Klarar {formatMeetingHours(meetingHoursFor(m))}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Fakta */}
        <section className="mb-8">
          <SectionHeading>Teknik och licenser</SectionHeading>
          <div className="grid gap-5 md:grid-cols-3">
            {FACTS.map((fact) => (
              <div key={fact.title}>
                <h4 className="text-sm font-semibold mb-1">{fact.title}</h4>
                <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{fact.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Om skaparen */}
        <section className="rounded-xl bg-[var(--color-primary)]/[0.06] border border-[var(--color-primary)]/15 p-4 flex items-start gap-3">
          <div className="text-[var(--color-primary)] mt-0.5 shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
            </svg>
          </div>
          <div>
            <h4 className="text-sm font-semibold mb-1">Om skaparen</h4>
            <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
              MötesSkribent är skapad av Erik Nunez, som arbetar med AI inom HR i Västerås stad. Verktyget är byggt
              för att göra mötesanteckningar enklare utan att ge upp kontrollen över datan.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
