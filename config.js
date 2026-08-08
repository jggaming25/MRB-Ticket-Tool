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
      'Wir bauen die Mitteldeutsche Regionalbahn in Roblox nach – von der Fahrzeugausstattung über ' +
      'den Fahrplan bis zum Bahnbetrieb. Dieses Ticketsystem ist der zentrale Anlaufpunkt für ' +
      'Feedback, Fehlermeldungen und Anfragen zu unserem Projekt.',
    sections: [
      {
        title: 'Über das Projekt',
        text:
          'Die Mitteldeutsche Regionalbahn bringt den Nahverkehr nach Roblox: detailgetreue Triebzüge, ' +
          'Bahnhöfe und ein realistischer Fahrbetrieb. Egal ob du als Fahrgast mitspielen oder uns als ' +
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
  // Tickets
  // ---------------------------------------------------------------------------
  // Kategorien, die der Ticket-Eroeffner beim Erstellen auswaehlen kann.
  categories: ['Allgemein', 'Account', 'Bug', 'Zahlung', 'Projekt', 'Sonstiges'],

  // Vordefinierte "naechste Aktionen", die der Bearbeiter beim Festlegen der
  // Faelligkeit auswaehlen kann.
  nextActions: [
    'Rückfrage an den Kunden',
    'Problem beheben',
    'Dokumentation erstellen',
    'Externen Anbieter kontaktieren',
    'Lösung prüfen',
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
  // Backups (taeglich, automatisch beim Start + alle 24 h)
  // ---------------------------------------------------------------------------
  backup: {
    dir: path.join(__dirname, 'backups'),
    keepDays: 30,
  },

  // Alle Anhaenge-Typen, die im Ticketverlauf direkt als Bildvorschau angezeigt
  // werden (sonst nur Download-Link).
  imagePreviewMime: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
};
