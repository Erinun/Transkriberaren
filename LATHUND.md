# Lathund — MötesSkribent

## Del 1: Utvecklarguide — Släppa en ny version

### Förutsättningar (engångskonfiguration)

Dessa behöver bara göras en gång:

1. **Signeringsnyckel** finns redan i `~/.tauri/motesskribent.key`
2. **GitHub Secrets** måste finnas i repot (Settings → Secrets → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — innehållet i `~/.tauri/motesskribent.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — lösenordet du valde vid nyckelgenerering

### Steg-för-steg: Ny release

#### 1. Se till att alla ändringar är pushade

```bash
git status
# Om det finns opushade commits eller workflow-ändringar:
git push
```

**VIKTIGT:** Om du har ändrat `.github/workflows/release.yml` eller andra filer — pusha dem FÖRST innan du skapar en tagg. GitHub Actions använder workflow-filen från taggen, så taggen måste skapas EFTER att workflow-ändringarna finns på GitHub.

#### 2. Bumpa version i Gitbash

```bash
./scripts/bump-version.sh 0.6.0
```

Skriptet uppdaterar versionen i tre filer automatiskt:
- `pyproject.toml`
- `src-tauri/tauri.conf.json`
- `app/package.json`

...och skapar en commit + git-tagg (`v0.6.0`).

#### 3. Pusha till GitHub i Gitbash

```bash
git push && git push --tags
```

Detta triggar GitHub Actions-workflowet som bygger appen.

#### 4. Vänta på bygget (~40 min)

Följ bygget på: https://github.com/Erinun/Transkriberaren/actions

#### 5. Verifiera releasen

```bash
# Kolla att bygget lyckades
gh run list -R Erinun/Transkriberaren --limit 1

# Kolla att alla artefakter finns
gh release view v0.6.0 -R Erinun/Transkriberaren --json assets --jq '.assets[].name'
```

Du ska se minst dessa filer:
- `MotesSkribent_0.6.0_x64-setup.exe` (installern)
- `MotesSkribent_0.6.0_x64-setup.nsis.zip.sig` (signatur)
- `latest.json` (update-manifest — **denna är kritisk för auto-uppdatering!**)

Om `latest.json` saknas fungerar INTE auto-uppdateringen.

### Checklista vid varje release

- [ ] Alla kod- och workflow-ändringar är pushade till GitHub INNAN tagg
- [ ] `bump-version.sh` kördes med rätt versionsnummer
- [ ] `git push && git push --tags` kördes
- [ ] GitHub Actions-bygget lyckades (grön bock)
- [ ] `latest.json` finns bland release-artefakterna
- [ ] Testa att en befintlig installation hittar uppdateringen

---

## Del 2: Befintliga användare — Uppdatera appen

### Automatisk uppdatering (rekommenderat)

MötesSkribent kollar automatiskt efter nya versioner varje gång du startar appen.

1. **Starta appen** som vanligt
2. Om en ny version finns visas en **blå banner** högst upp i fönstret med texten:
   > "Version X.Y.Z är tillgänglig!"
3. Klicka på **"Uppdatera nu"**
4. Vänta medan uppdateringen laddas ner (en progressindikator visas)
5. När nedladdningen är klar visas knappen **"Starta om"**
6. Klicka **"Starta om"** — appen stängs, installerar uppdateringen och startar igen

Klart! Du kör nu den senaste versionen.

### Felsökning

**Ingen uppdateringsbanner visas?**
- Kontrollera att du har internetanslutning
- Stäng appen helt och starta om den (bannern visas bara vid uppstart)
- Du kanske redan kör den senaste versionen

**Uppdateringen misslyckas?**
- Ladda ner den senaste versionen manuellt (se Del 3 nedan)

---

## Del 3: Nya användare — Ladda ner och installera

### Steg 1: Ladda ner installern

Gå till: **https://github.com/Erinun/Transkriberaren/releases/latest**

Klicka på filen som heter **`MotesSkribent_X.Y.Z_x64-setup.exe`** (där X.Y.Z är versionsnumret).

### Steg 2: Kör installern

1. Dubbelklicka på den nedladdade `.exe`-filen
2. **Windows SmartScreen-varning** kan visas eftersom appen inte är signerad med ett köpt certifikat:
   - Klicka på **"Mer info"** (eller "More info")
   - Klicka på **"Kör ändå"** (eller "Run anyway")
3. Följ installationsguiden — standardinställningarna fungerar bra
4. Appen installeras i din användarmapp (ingen admin-behörighet krävs)

### Steg 3: Starta appen

- Öppna **MötesSkribent** från Startmenyn eller skrivbordet
- Första starten kan ta lite längre tid medan modeller laddas

### Steg 4: Transkribera ett möte

1. Klicka på **"Välj ljudfil"** och välj en inspelning (.wav, .mp3, etc.)
2. Ange **antal talare** om du vill ha talaridentifiering
3. Klicka på **"Starta transkribering"**
4. Vänta medan transkriberingen körs (kan ta några minuter beroende på filens längd)
5. Resultatet visas direkt i appen — du kan kopiera eller spara det

### Framtida uppdateringar

När du väl har installerat appen behöver du inte ladda ner nya versioner manuellt. Appen meddelar dig automatiskt när en uppdatering finns tillgänglig (se Del 2).
