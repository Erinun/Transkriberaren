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

Skriv en koncis sammanfattning på svenska. Svara i ren text utan markdown-formatering (inga asterisker, rubriktecken eller andra markeringar).`,
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
1. [Åtgärd] - Ansvarig: [Person] (om det framgår)

Svara i ren text utan markdown-formatering (inga asterisker, rubriktecken eller andra markeringar).`,
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

Skriv ett formellt mötesprotokoll på svenska. Svara i ren text utan markdown-formatering (inga asterisker, rubriktecken eller andra markeringar).`,
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

Skriv den renskrivna texten på svenska. Behåll talarmarkeringarna. Svara i ren text utan markdown-formatering (inga asterisker, rubriktecken eller andra markeringar).`,
  },
  {
    id: "custom",
    name: "Egen prompt",
    description: "Skriv en egen instruktion",
    template: "",
    isCustom: true,
  },
];

/**
 * Strip markdown formatting from transcription before sending to LLM.
 * Reduces token count by ~200-300 tokens per transcription.
 */
export function stripMarkdownForLLM(md: string): string {
  let text = md;
  // Remove "# Mötesprotokoll" header
  text = text.replace(/^#\s+.+$/gm, "");
  // Remove horizontal rules
  text = text.replace(/^-{3,}$/gm, "");
  // Remove bold markers (e.g. **Talare 1:**)
  text = text.replace(/\*\*/g, "");
  // Remove italic footer (e.g. *Genererat av...*)
  text = text.replace(/^\*[^*]+\*$/gm, "");
  // Remove trailing double spaces (markdown linebreak)
  text = text.replace(/ {2,}$/gm, "");
  // Collapse multiple blank lines to one
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function buildPrompt(
  template: PromptTemplate,
  transcription: string,
  context: string,
  customPrompt?: string,
): string {
  const stripped = stripMarkdownForLLM(transcription);

  if (template.isCustom) {
    const base = customPrompt ?? "";
    return `${base}\n\nSvara i ren text utan markdown-formatering (inga asterisker, rubriktecken eller andra markeringar).\n\nTRANSKRIBERING:\n${stripped}`;
  }
  let prompt = template.template;
  prompt = prompt.replace("{transcription}", stripped);
  prompt = prompt.replace(
    "{context}",
    context ? `EXTRA KONTEXT:\n${context}` : "",
  );
  return prompt;
}
