# Installationsguide — MötesSkribent

## 1. Ladda ner

Ladda ner filen **MotesSkribent_x64.zip** från releases.

## 2. Extrahera och installera

1. Extrahera zip-filen till valfri plats.
2. Dubbelklicka på installern (`.exe`-filen i zip-arkivet).
3. **Windows SmartScreen-varning** kan visas eftersom appen inte är signerad med ett certifikat. Klicka **"Mer info"** och sedan **"Kör ändå"**.
4. Följ installationsguiden. Appen installeras per användare — ingen administratörsbehörighet krävs.

## 3. Bundlade modeller

Installationen inkluderar tre AI-modeller för transkribering:

| Modell | Storlek | Beskrivning |
|--------|---------|-------------|
| **kb-whisper-tiny** | ~160 MB | Snabbast, bra för svagare datorer |
| **kb-whisper-base** | ~240 MB | Standard, rekommenderas (2x snabbare än small) |
| **kb-whisper-small** | ~460 MB | Bäst balans hastighet/kvalitet |

Modell väljs i **Inställningar** i appen. Standardmodellen är **base**.

> **Medium och Large**: Dessa större modeller ingår inte i installationen. Om du vill använda dem krävs internetanslutning vid första körning — modellen laddas ned automatiskt.

## 4. Första start

Starta **MötesSkribent** från startmenyn eller skrivbordsgenvägen.

Appen fungerar **helt offline** — alla AI-modeller för transkribering och talaridentifiering ingår i installationen. Inga konton, licenser eller internetanslutning krävs.

> **Obs:** Första transkriberingen kan ta lite längre tid medan modellerna laddas in i minnet. Efterföljande körningar går snabbare.

## 5. Användning

1. **Välj ljudfil** — Klicka "Välj ljudfil" och välj en inspelning (WAV, MP3, M4A, etc.)
2. **Ange antal talare** — Ställ in hur många personer som deltog i mötet
3. **Transkribera** — Klicka "Transkribera" och vänta medan appen bearbetar ljudet
4. **Spara** — Resultatet visas som ett mötesprotokoll med talarmarkeringar, redo att sparas som Markdown- eller Word-fil (DOCX)

## 6. Avinstallera

Öppna **Windows Inställningar** → **Appar** → **Installerade appar**, sök efter "MötesSkribent" och klicka **Avinstallera**.
