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

Skriv en koncis sammanfattning på svenska. Använd markdown-formatering med rubriker (##), fetstil för viktiga punkter, och punktlistor där det passar.`,
  },
  {
    id: "action-items",
    name: "Åtgärdspunkter",
    description: "Extrahera beslut och åtgärder",
    template: `Du är en professionell mötessekreterare. Analysera följande mötesprotokoll och lista alla beslut och åtgärdspunkter. Ange vem som ansvarar för varje punkt om det framgår.

{context}

TRANSKRIBERING:
{transcription}

Lista alla åtgärdspunkter och beslut på svenska. Använd markdown-formatering:
- Numrerad lista för åtgärdspunkter
- **Fetstil** för ansvarig person
- Gruppera efter ämne med rubriker (##) om det finns flera ämnen.`,
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

Skriv ett formellt mötesprotokoll på svenska. Använd markdown-formatering med rubriker (##) för varje avsnitt, **fetstil** för namn och beslut, och punktlistor.`,
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

Skriv den renskrivna texten på svenska. Behåll talarmarkeringarna med **fetstil** för talarnamn.`,
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

/**
 * Estimate token count for a text string.
 * Swedish text averages ~4 characters per token.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildPrompt(
  template: PromptTemplate,
  transcription: string,
  context: string,
  customPrompt?: string,
): string {
  const stripped = stripMarkdownForLLM(transcription);
  const contextBlock = context ? `EXTRA KONTEXT:\n${context}\n\n` : "";

  if (template.isCustom) {
    const base = customPrompt ?? "";
    return `${base}\n\nFormatera svaret med markdown (rubriker, fetstil, listor).\n\n${contextBlock}TRANSKRIBERING:\n${stripped}`;
  }

  // Auto-wrap: mallar utan {transcription}-platshållare får transkriptionen tillagd automatiskt
  if (!template.template.includes("{transcription}")) {
    return `${template.template}\n\nFormatera svaret med markdown (rubriker, fetstil, listor).\n\n${contextBlock}TRANSKRIBERING:\n${stripped}`;
  }

  // Legacy: inbyggda mallar med platshållare
  let prompt = template.template;
  prompt = prompt.replace("{transcription}", stripped);
  prompt = prompt.replace(
    "{context}",
    context ? `EXTRA KONTEXT:\n${context}` : "",
  );
  return prompt;
}
