# Lathund — MötesSkribent

## Del 1: Utvecklarguide — Släppa en ny version

### Förutsättningar (engångskonfiguration)

Dessa behöver bara göras en gång:

1. **Signeringsnyckel** finns redan i `~/.tauri/motesskribent.key`
2. **GitHub Secrets** måste finnas i repot (Settings → Secrets → Actions):
   - `TAURI_SIGNING_PRIVATE_KEY` — innehållet i `~/.tauri/motesskribent.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — lösenordet du valde vid nyckelgenerering

### Innan du börjar: så kopierar du kommandon

> **Kopiera bara själva kommandoraden.** Raderna med tre backticks (```` ``` ````) och ordet `bash` hör till dokumentets formatering och ska **inte** klistras in.
> Git Bash tolkar backticks som ett kommando i kommandot, så raden körs inte, och du får inget felmeddelande.

Kör alla kommandon nedan i **Git Bash** från projektmappen `/c/Dev/Transkriberaren`.

### Snabbversion (när allt redan är committat)

Byt `X.Y.Z` mot den nya versionen, t.ex. `0.7.2`:

```bash
./scripts/bump-version.sh X.Y.Z
```
```bash
git push && git push --tags
```

Mer behöver du inte göra. Nedan står samma sak steg för steg, med kontroller.

### Steg-för-steg: Ny release

#### 1. Kolla att allt är committat och pushat

```bash
git status
```

Du ska se `nothing to commit, working tree clean` och `Your branch is up to date with 'origin/main'`.

- Står det ändrade filer? Committa dem först.
- Står det `Your branch is ahead`? Kör `git push`.

**VIKTIGT:** Har du ändrat `.github/workflows/release.yml` måste den ändringen vara pushad *innan* du skapar taggen. GitHub Actions använder workflow-filen som finns i taggen.

#### 2. Ta reda på nuvarande version

```bash
git describe --tags --abbrev=0
```

Visar senaste taggen, t.ex. `v0.7.1`. Välj nästa nummer:

| Typ av ändring | Exempel |
|---|---|
| Buggfix, små ändringar | `0.7.1` → `0.7.2` |
| Ny funktion | `0.7.1` → `0.8.0` |

#### 3. Bumpa versionen

```bash
./scripts/bump-version.sh 0.7.2
```

Skriptet ändrar versionen i fyra filer:
- `pyproject.toml`
- `src-tauri/tauri.conf.json`
- `app/package.json`
- `app/package-lock.json`

`package-lock.json` behöver alltså inte längre synkas för hand. Sedan skapar skriptet en commit (`Bumpa version till 0.7.2`) och taggen `v0.7.2`.

**Så ser du att det fungerade:** skriptet skriver `Bumpar till version 0.7.2...`, sedan en lista över filerna och till sist `Klart! Kör nu: git push && git push --tags`.
Får du **ingen utskrift alls** har skriptet inte körts. Kontrollera då att du inte råkade klistra in backticks.

#### 4. Pusha till GitHub

```bash
git push && git push --tags
```

Båda kommandona ska skriva ut något i stil med `main -> main` respektive `[new tag] v0.7.2 -> v0.7.2`.
Står det `Everything up-to-date` på båda har bumpen inte gjorts, gå tillbaka till steg 3.

Den nya taggen startar bygget på GitHub Actions.

#### 5. Vänta på bygget (~40 min)

Följ bygget här: https://github.com/Erinun/Transkriberaren/actions

#### 6. Verifiera releasen

```bash
gh run list -R Erinun/Transkriberaren --limit 1
```
```bash
gh release view v0.7.2 -R Erinun/Transkriberaren --json assets --jq '.assets[].name'
```

Det första kommandot ska visa `completed success`. Det andra ska lista minst:
- `MotesSkribent_0.7.2_x64-setup.exe` (installern)
- `MotesSkribent_0.7.2_x64-setup.nsis.zip.sig` (signaturen)
- `latest.json` (**krävs för att auto-uppdateringen ska fungera**)

### Om något går fel

**Fel versionsnummer, men du har inte pushat än:**
```bash
git tag -d v0.7.2
```
```bash
git reset --hard HEAD~1
```
Det tar bort taggen och bump-commiten. Kör sedan steg 3 igen med rätt nummer.
(`reset --hard` slänger även osparade ändringar, men om steg 1 var rent finns inga.)

**Bygget misslyckades efter att du pushat:** rätta felet, committa och pusha rättelsen. Bumpa sedan till *nästa* version (t.ex. `0.7.3`). Återanvänd aldrig en tagg som redan finns på GitHub.

**`Fel: Version måste vara i formatet X.Y.Z`:** skriv bara siffrorna, utan `v`. Skriv alltså `0.7.2`, inte `v0.7.2`.

**`npm: command not found`:** skriptet använder npm för att uppdatera `app/package.json` och `app/package-lock.json`. Node.js måste vara installerat. Starta om Git Bash efter installationen.

### Checklista vid varje release

- [ ] `git status` visar ren arbetskopia och "up to date"
- [ ] `bump-version.sh` kördes och skrev ut "Klart!"
- [ ] `git push && git push --tags` visade den nya taggen (inte bara "Everything up-to-date")
- [ ] GitHub Actions-bygget lyckades (grön bock)
- [ ] `latest.json` finns bland release-filerna
- [ ] En befintlig installation hittar uppdateringen

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
