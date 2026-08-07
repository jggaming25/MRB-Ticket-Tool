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

### 4. Staff festlegen

Zwei Möglichkeiten:

- **Ohne `STAFF_IDS`** (empfohlen für den Start): Der **erste** Nutzer, der sich einloggt, wird automatisch Admin und kann weitere Staff-Mitglieder über **Admin → Nutzerverwaltung** hinzufügen.
- **Mit `STAFF_IDS`**: Kommagetrennte Discord-User-IDs eintragen. Diese Liste wird dann ausschließlich aus der Konfiguration gelesen und kann nicht über die Oberfläche geändert werden.

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
├── db.js                # SQLite-Datenbank (Schema & Helfer)
├── discord.js           # Discord OAuth2-Logik
├── middleware.js        # Auth-Middleware & Helfer
├── data/tickets.db      # SQLite-Datenbank (wird automatisch erzeugt)
├── uploads/             # Ticket-Anhänge
├── views/               # EJS-Templates (Login, Dashboard, Tickets, Admin)
└── public/              # CSS, JS, Bilder
```

## Hinweise

- **Anhänge** werden unter `uploads/` gespeichert und sind nur für Ticket-Besitzer und Staff zugänglich.
- Die Session hält **7 Tage**.
- **Rate-Limits**: max. 10 Ticket-Erstellungen/Stunde, Login-Anfragen sind limitiert.
- Für Produktion empfehle ich zusätzlich einen Reverse-Proxy (z. B. Nginx mit HTTPS) – dann `BASE_URL` und `DISCORD_REDIRECT_URI` auf die echte Domain setzen.

## Backup

Einfach den Ordner `data/` (und `uploads/`) kopieren – das ist die komplette Datenhaltung.
