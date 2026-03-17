export interface PromptTemplate {
  id: string;
  name: string;
  description: string;
  template: string;
  isCustom?: boolean;
}

export const PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: "summary",
    name: "Sammanfattning",
    description: "Sammanfatta mötets viktigaste punkter",
    template: `Du är en professionell mötessekreterare. Sammanfatta följande mötesprotokoll på svenska. Fokusera på de viktigaste diskussionspunkterna, beslut som fattades, och vem som sa vad.

{context}

TRANSKRIBERING:
{transcription}

Skriv en koncis sammanfattning på svenska.`,
  },
  {
    id: "action-items",
    name: "Åtgärdspunkter",
    description: "Extrahera beslut och åtgärder",
    template: `Du är en professionell mötessekreterare. Analysera följande mötesprotokoll och lista alla beslut och åtgärdspunkter. Ange vem som ansvarar för varje punkt om det framgår.

{context}

TRANSKRIBERING:
{transcription}

Lista alla åtgärdspunkter och beslut som en numrerad lista på svenska. Formatera som:
1. [Åtgärd] - Ansvarig: [Person] (om det framgår)`,
  },
  {
    id: "minutes",
    name: "Mötesprotokoll",
    description: "Skapa formellt mötesprotokoll",
    template: `Du är en professionell mötessekreterare. Skapa ett formellt mötesprotokoll baserat på följande transkribering. Protokollet ska innehålla:
- Mötets deltagare (baserat på talare)
- Dagordningspunkter
- Diskussionspunkter
- Beslut
- Åtgärdspunkter

{context}

TRANSKRIBERING:
{transcription}

Skriv ett formellt mötesprotokoll på svenska.`,
  },
  {
    id: "cleanup",
    name: "Renskrivning",
    description: "Rensa bort utfyllnadsord och upprepningar",
    template: `Du är en professionell textredaktör. Renskriva följande transkribering genom att:
- Ta bort utfyllnadsord (eh, öh, liksom, typ, alltså, ju)
- Ta bort upprepningar och stammningar
- Korrigera grammatik och meningsbyggnad
- Behåll den ursprungliga betydelsen och talarnas intentioner
- Behåll talarbytena och tidsstämplarna

{context}

TRANSKRIBERING:
{transcription}

Skriv den renskrivna texten på svenska. Behåll talarmarkeringarna.`,
  },
  {
    id: "custom",
    name: "Egen prompt",
    description: "Skriv en egen instruktion",
    template: "",
    isCustom: true,
  },
];

export function buildPrompt(
  template: PromptTemplate,
  transcription: string,
  context: string,
  customPrompt?: string,
): string {
  if (template.isCustom) {
    return `${customPrompt ?? ""}\n\nTRANSKRIBERING:\n${transcription}`;
  }
  let prompt = template.template;
  prompt = prompt.replace("{transcription}", transcription);
  prompt = prompt.replace(
    "{context}",
    context ? `EXTRA KONTEXT:\n${context}` : "",
  );
  return prompt;
}
