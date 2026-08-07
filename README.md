# TicketSystem MRB

Ein vollständiges Support-Ticketsystem mit **Discord-Login (OAuth2)**, Ticket-Erstellung, Nachrichtenverlauf, Anhängen, Admin-/Staff-Panel und **dauerhafter Speicherung in SQLite**.

## Funktionen

- 🔐 **Discord OAuth2-Login** – kein Passwort nötig, nur „Mit Discord einloggen“
- 🎫 **Ticket-Erstellung** mit Betreff, Kategorie und Priorität
- 💬 **Nachrichtenverlauf** – Nutzer & Staff antworten direkt im Ticket
- 📎 **Datei-Anhänge** (bis 5 MB: PNG, JPG, GIF, WebP, PDF, TXT, MD, JSON, ZIP)
- 📋 **Meine Tickets** – Übersicht, Status & letzte Aktivität
- 🔒 **Admin-/Staff-Panel** – alle Tickets filtern (Status/Kategorie/Priorität/Suche), Status ändern, Tickets zuweisen, Nutzer verwalten
- 💾 **SQLite-Speicherung** – Nutzer, Tickets, Nachrichten & Einstellungen werden dauerhaft in `data/tickets.db` gespeichert (WAL-Modus, überlebt Neustarts)

## Voraussetzungen

- Node.js **22.5+** (Node 24 empfohlen, nutzt das eingebaute `node:sqlite`)
- Ein Discord-Entwickler-Account (kostenlos)

## Einrichtung

### 1. Dependencies installieren

```bash
npm install
```

### 2. Discord-Application erstellen

1. Öffne das [Discord Developer Portal](https://discord.com/developers/applications) und klicke **New Application**.
2. Wähle einen Namen (z. B. „MRB TicketSystem“) und erstelle die App.
3. Gehe links auf **OAuth2 → General**:
   - Notiere **Client ID** und **Client Secret**.
   - Füge unter **Redirects** folgende URL hinzu:
     ```
     http://localhost:3000/auth/callback
     ```
   - Unter **Default Authorization Link** → **Scopes** ist `identify` gesetzt (E-Mail über `identify email`, optional).
4. Kopiere die App-ID deines Discord-Servers: Rechtsklick auf den Server → **Server-Einstellungen → Widget → Server-ID** (nur nötig, falls du Server-Mitgliedschaft prüfen willst – optional).

### 3. Konfiguration

```bash
copy .env.example .env
```

Öffne `.env` und trage deine Werte ein:

```env
DISCORD_CLIENT_ID=deine_client_id
DISCORD_CLIENT_SECRET=dein_client_secret
DISCORD_REDIRECT_URI=http://localhost:3000/auth/callback
PORT=3000
SESSION_SECRET=ein_langer_zufaelliger_string
STAFF_IDS=
```

Einen sicheren `SESSION_SECRET` erzeugst du mit:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 4. Staff / HR-HR festlegen

In `.env` legst du fest, welche Discord-Usernames die **HR-HR** (Root) sind – die einzigen mit Zugriff auf HR-Verwaltung, Audit-Log und Rechtevergabe:

```env
AUTHORIZED_DISCORD_USERNAMES=jlg09
```

Mehrere Namen mit Komma trennen (z. B. `jlg09,dein_zweiter_name`). Diese Nutzer werden beim ersten Discord-Login als HR-HR eingerichtet (E-Mail verifizieren + Passwort festlegen). Alle anderen Discord-Nutzer werden normale Kunden.

### 5. Starten

```bash
npm start
```

Dann öffne http://localhost:3000

### 6. Testen (optional)

```bash
npm test
```

Führt einen automatisierten Durchlauf gegen eine separate Test-Datenbank aus (Login-Simulation, Ticket-Erstellung, Antworten, Admin-Aktionen, Schließen/Öffnen).

## Projektstruktur

```
├── server.js            # Express-Server, alle Routen
├── db.js                # Datenbank (lokal SQLite oder Turso-Cloud)
├── discord.js           # Discord OAuth2-Logik
├── middleware.js        # Auth-Middleware & Helfer
├── config.js            # Zentrale Konfiguration (Marke, Homepage, Links, Fälligkeit)
├── render.yaml          # Render-Blueprint (Web-Service + Keep-Awake-Cron)
├── data/tickets.db      # Lokale SQLite-Datenbank (wird automatisch erzeugt)
├── views/               # EJS-Templates (Login, Dashboard, Tickets, Admin)
└── public/              # CSS, JS, Bilder
```

## Deploy auf Render (Produktion, kostenlos)

GitHub Pages kann diese App **nicht** betreiben, weil sie einen Node.js-Server
braucht. So kommst du dauerhaft online – **ohne Kreditkarte**, mit automatischer
Datenhaltung in der Turso-Cloud:

### 1. Code nach GitHub pushen

Alle Dateien außer `.env`, `node_modules/`, `data/` und `uploads/` (siehe `.gitignore`) in ein (privates) GitHub-Repo hochladen.

### 2. Turso-Datenbank anlegen (kostenlos)

1. Konto auf https://turso.tech anlegen.
2. **Create database** → Name z. B. `ticketsystem`, eine Region wählen.
3. Bei der Datenbank **Generate token** → Token kopieren.
4. Merke dir **URL** (sieht so aus: `libsql://ticketsystem-<dein-org>.turso.io`) und **Token**.

### 3. Discord-App anpassen

Im [Discord Developer Portal](https://discord.com/developers/applications) bei deiner App unter **OAuth2 → General → Redirects** die Deploy-URL ergänzen:

```
https://ticketsystem-mrb.onrender.com/auth/callback
```

(Statt `ticketsystem-mrb` deinen Namen eintragen, falls er schon vergeben ist.)

### 4. Auf Render deployen

1. Konto auf https://render.com anlegen.
2. **New → Blueprint** → dein GitHub-Repo auswählen.
3. Render erkennt `render.yaml`. Beim ersten Deploy fragt es nach allen geheimen Werten (`sync: false`):
   - `TURSO_URL` und `TURSO_AUTH_TOKEN` aus Schritt 2
   - `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` aus dem Developer Portal
   - `DISCORD_REDIRECT_URI` auf die Deploy-URL setzen
   - `DISCORD_GUILD_ID` (optional, Server-Pflicht) und `DISCORD_INVITE_URL`
   - `AUTHORIZED_DISCORD_USERNAMES` (deine HR-HR-Namen, z. B. `jlg09`)
   - `SMTP_*` (optional, für echte E-Mails z. B. Brevo)
4. **Deploy** starten.

**Wichtig:** Trage nach dem ersten Deploy überall die echte URL ein (in `BASE_URL`
und `DISCORD_REDIRECT_URI`), falls sie von `ticketsystem-mrb.onrender.com` abweicht.

### 5. Schlafen verhindern (schon erledigt)

In `render.yaml` ist ein **Keep-Awake-Cron** enthalten, der alle 10 Minuten
`/healthz` aufruft. Damit schläft die kostenlose Instanz nicht ein und bleibt
24/7 erreichbar.

## Hinweise

- **Anhänge** werden direkt in der Datenbank gespeichert (nicht im Dateisystem). So gehen sie auch bei einem Render-Neustart/Deploy nicht verloren.
- Die Session hält **7 Tage**.
- **Rate-Limits**: max. 10 Ticket-Erstellungen/Stunde, Login-Anfragen sind limitiert.
- Lokal: `BASE_URL` und `DISCORD_REDIRECT_URI` auf `http://localhost:3000` lassen.

## Backup

- **Lokal:** Einfach `data/tickets.db` kopieren (oder den automatischen `backups/`-Ordner).
- **Produktion (Turso):** Turso sichert die Datenbank automatisch. Optional kann man in der Turso-Konsole regelmäßig manuelle Backups anlegen.
