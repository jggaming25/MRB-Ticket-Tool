'use strict';

const path = require('node:path');

// =============================================================================
// Zentrale Konfiguration – hier alles anpassen, was der Kunde sehen darf:
// Markenname, Homepage-Texte, Kategorien, "nächste Aktion"-Auswahl, Fälligkeit,
// Bildordner fuer das Karussell, Logo, Backups.
// =============================================================================
module.exports = {
  // Marke / allgemein
  brand: 'TicketSystem MRB',
  tagline: 'Support-Plattform für das Roblox-Zugprojekt Mitteldeutsche Regionalbahn',
  logo: '/static/logo.png',

  // ---------------------------------------------------------------------------
  // Homepage (oeffentliche Startseite "/")
  // ---------------------------------------------------------------------------
  home: {
    heroTitle: 'Mitteldeutsche Regionalbahn',
    heroSubtitle: 'Unser Roblox-Zugprojekt',
    heroText:
      'Wir sind ein Fiktives Shift Game was sich noch in Entwicklung befindet. ' +
      'Vom Fahrplan bis zum Stellwerk. ' +
      'Feedback, Fehlermeldungen und Anfragen zu unserem Projekt.',
    // Hinweis auf der Startseite für noch nicht eingeloggte Besucher.
    heroHint:
      'Nach dem Login siehst du hier alle internen Bereiche und Links – wenn du auf Discord ' +
      'deine Rolle bereits erhalten hast. Sonst siehst du nur deine Tickets.',
    sections: [
      {
        title: 'Über das Projekt',
        text:
          'Die Mitteldeutsche Regionalbahn bringt den Nahverkehr nach Roblox: detailgetreue Triebzüge, ' +
          'Bahnhöfe und ein realistisch / Fiktiver Fahrbetrieb. Egal ob du als Fahrgast mitspielen oder uns als ' +
          'Mitarbeiter unterstützen möchtest – hier erfährst du alles.',
      },
      {
        title: 'Support & Tickets',
        text:
          'Du hast einen Fehler gefunden, eine Frage oder einen Wunsch? Erstelle ein Ticket und beschreibe ' +
          'dein Anliegen. Unser Team übernimmt dein Ticket, setzt Fristen und hält dich per E-Mail auf dem ' +
          'Laufenden – bis alles erledigt ist.',
      },
      {
        title: 'Wie es funktioniert',
        text:
          '1. Mit deinem Discord-Konto einloggen.\n' +
          '2. Ticket mit Betreff, Beschreibung und ggf. Anhang erstellen.\n' +
          '3. Unser Team übernimmt dein Ticket und du bekommst zu jeder Änderung eine E-Mail.\n' +
          '4. Sobald alles abgeschlossen ist, wird das Ticket zur Freigabe vorgelegt und geschlossen.',
      },
    ],
    imageDir: path.join(__dirname, 'public', 'images'),
    imageUrlPrefix: '/static/images/',
    slideSeconds: 10, // Bilderwechsel auf der Startseite (Sekunden)
  },

  // ---------------------------------------------------------------------------
  // Interne Links – nur für HR und HR-HR sichtbar (erscheinen als "Interne
  // Links" in der Navigation und auf der Mainpage, sobald man eingeloggt ist).
  // ---------------------------------------------------------------------------
  staffLinks: [
    { label: 'Anwesenheitstool', url: 'https://anwesenheit-new.web.app/' },
    { label: 'OnlineBefehl & Fahrplan', url: 'https://jggaming25.github.io/MRB-OnlineBefehl/index.html#/login' },
  ],

  // ---------------------------------------------------------------------------
  // Discord-Rollen mit Zugriff auf "Interne Links" / interne Bereiche.
  // Nutzer, deren Discord-Konto eine dieser Rollen auf dem Server hat
  // (DISCORD_GUILD_ID in .env), sehen nach dem Login den Tab "Interne Links".
  // Nutzer ohne diese Rollen sehen nur ihre Tickets. Du findest die Rollen-ID
  // in Discord: Server-Einstellungen -> Rollen -> Rolle -> "…" -> ID kopieren
  // (Entwicklermodus aktivieren unter Einstellungen -> Erweitert).
  // ---------------------------------------------------------------------------
  staffDiscordRoleIds: [
    '1497926771872366644',
    '1450856112101396623',
    '1450563150939160646',
    '1450856176987148390',
    '1450856244897386619',
    '1450856362014937188',
    '1450563071100584010',
    '1446162014991814788',
    '1446161959916667041',
    '1531039189179564223',
    '1531037872038088794',
    '1531038796576063618',
    '1450856053364363405',
    '1535379321659723877',
    '1446161791385337958',
    '1446161872519958703',
  ],

  // ---------------------------------------------------------------------------
  // Tickets
  // ---------------------------------------------------------------------------
  // Kategorien, die der Ticket-Eroeffner beim Erstellen auswaehlen kann.
  categories: ['Allgemein', 'Account', 'Bug', 'Player Report', 'Sonstiges'],

  // Vordefinierte "naechste Aktionen", die der Bearbeiter beim Festlegen der
  // Faelligkeit auswaehlen kann.
  nextActions: [
    'Rückfrage an den User',
    'Problem beheben',
    'Dokumentation erstellen',
    'Informationsweitergabe Intern',
    'Lösung prüfen',
    'Anliegen Prüfen'
    ,"Ticket schließen",
  ],

  // Fälligkeit: Nach jeder Bearbeitung durch den Support wird die Fälligkeit um
  // so viele Stunden erneuert. Tickets ohne Aktion nach dem Fälligkeitsdatum
  // gelten als ueberfaellig.
  due: {
    defaultHours: 24,
  },

  ticket: {
    subjectMaxLength: 120,
    bodyMinLength: 5,
  },

  // ---------------------------------------------------------------------------
  // Backups (alle Daten; werden in der DB gespeichert und gelten damit auch
  // bei Turso/Render). Wöchentlich automatisch, maximal `max` Stück.
  // Monatlich wird automatisch aufgeräumt, sodass die neuesten `monthlyKeep`
  // Backups übrig bleiben. Manuell kann der Inhaber jederzeit aufräumen.
  // ---------------------------------------------------------------------------
  backup: {
    dir: path.join(__dirname, 'backups'),
    max: 20,
    monthlyKeep: 16,
    autoIntervalDays: 7,
    monthlyCleanupDays: 30,
  },

  // ---------------------------------------------------------------------------
  // Voice-Support / Support-Hotline
  // ---------------------------------------------------------------------------
  // HR/Inhaber können sich für den Voice-Support ein- und ausstempeln. Eingeloggte
  // Nutzer können die Hotline "anrufen" (über die Website, mit Warteschleife und
  // WebRTC-Sprachanruf). Die Hotline-Nummer wird automatisch aus den vorhandenen
  // Datenwerten (Tickets, Nutzer, Bearbeiter) abgeleitet.
  // ---------------------------------------------------------------------------
  support: {
    hotlinePrefix: '0800',       // Vorwahl der Support-Hotline
    ringTimeoutMs: 45 * 1000,    // Zeit, die ein zugewiesener Mitarbeiter zum Annehmen hat
    pollMs: 3000,                // Polling-Intervall der Clients (Server-Zustand)
    stunServers: ['stun:stun.l.google.com:19302'],
    noStaffMessage:
      'Derzeit ist leider kein Mitarbeiter für den Voice-Support verfügbar. ' +
      'Bitte versuchen Sie es später noch einmal.',
    queueEstimateLabel: 'Ihre voraussichtliche Wartezeit beträgt 1–2 Minuten.',
  },

  // Meldung, die bei gesperrtem Zugriff (Lockdown) auf der Login-Seite
  // und im Einstellungs-Bereich angezeigt wird.
  lockdownMessage: 'Der Zugriff auf das System wurde gerade für alle Bearbeiter gesperrt.',

  // Alle Anhaenge-Typen, die im Ticketverlauf direkt als Bildvorschau angezeigt
  // werden (sonst nur Download-Link).
  imagePreviewMime: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};
