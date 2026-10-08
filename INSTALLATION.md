# Installationsguide — MötesSkribent

## 1. Ladda ner

Ladda ner filen **MotesSkribent_x64.zip** från releases.

## 2. Extrahera och installera

1. Extrahera zip-filen till valfri plats.
2. Dubbelklicka på installern (`.exe`-filen i zip-arkivet).
3. **Windows SmartScreen-varning** kan visas eftersom appen inte är signerad med ett certifikat. Klicka **"Mer info"** och sedan **"Kör ändå"**.
4. Följ installationsguiden. Appen installeras per användare — ingen administratörsbehörighet krävs.

## 3. Bundlade modeller

Standardmotorn för transkribering är **Pianissimo** från Klang (int8, ~660 MB, kräver cirka 1,5 GB minne). Den är tränad för svenska. Pianissimo används under licensen CC BY 4.0, och Klang anges som upphovsman under Om MötesSkribent i appen.

Installationen innehåller dessutom **KB-Whisper Base** (~240 MB). Den kan väljas i stället för Pianissimo och används automatiskt som reserv om Pianissimo inte kan köras.

Motor väljs i **Inställningar** i appen. Standard är Pianissimo.

> **Tiny och Small** ingår inte längre (sedan 0.7.1), så att installationsfilen håller sig under GitHubs gräns på 2 GB.

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
