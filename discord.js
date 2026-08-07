'use strict';

const crypto = require('node:crypto');
const { db } = require('./db');

const DISCORD_API = 'https://discord.com/api/v10';
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || `${process.env.BASE_URL || 'http://localhost:3000'}/auth/callback`;
const GUILD_ID = String(process.env.DISCORD_GUILD_ID || '').trim();

function generateState() {
  const state = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(`oauth_state:${state}`, String(Date.now()));
  return state;
}

function verifyState(state) {
  if (!state) return false;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`oauth_state:${state}`);
  if (!row) return false;
  const age = Date.now() - Number(row.value);
  db.prepare('DELETE FROM settings WHERE key = ?').run(`oauth_state:${state}`);
  return age < 10 * 60 * 1000; // 10 Minuten gueltig
}

function getAuthUrl() {
  const state = generateState();
  // "guilds" ist nötig, um zu prüfen, ob sich der Nutzer auf unserem
  // Discord-Server befindet (DISCORD_GUILD_ID in .env).
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email guilds',
    state,
  });
  return { url: `https://discord.com/api/oauth2/authorize?${params}`, state };
}

// Ist eine Guild-ID in .env konfiguriert? Wenn nein, wird die Server-Prüfung
// beim Login übersprungen.
function isGuildCheckEnabled() {
  return GUILD_ID.length > 0;
}

// Prüft, ob der eingeloggte Discord-Nutzer Mitglied des konfigurierten Servers ist.
async function isInGuild(accessToken, guildId = GUILD_ID) {
  if (!guildId) return true; // keine Prüfung konfiguriert
  const res = await fetch(`${DISCORD_API}/users/@me/guilds`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Discord guilds fetch failed (${res.status})`);
  const guilds = await res.json();
  return Array.isArray(guilds) && guilds.some((g) => String(g.id) === String(guildId));
}

async function exchangeCode(code) {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord token exchange failed (${res.status}): ${text}`);
  }
  return res.json();
}

async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord user fetch failed (${res.status}): ${text}`);
  }
  return res.json();
}

function avatarUrl(user) {
  if (!user.avatar) return 'https://cdn.discordapp.com/embed/avatars/0.png';
  const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
}

function staffIds() {
  return String(process.env.STAFF_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Discord-Usernames, die sich als HR-HR registrieren duerfen (siehe .env).
function authorizedDiscordUsernames() {
  return String(process.env.AUTHORIZED_DISCORD_USERNAMES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isAuthorizedDiscord(dUser) {
  const list = authorizedDiscordUsernames();
  if (!list.length) return false;
  const candidates = [
    dUser.username,
    dUser.global_name,
    dUser.discriminator && dUser.discriminator !== '0' ? `${dUser.username}#${dUser.discriminator}` : null,
  ].filter(Boolean).map((s) => s.toLowerCase());
  return list.some((name) => candidates.includes(name));
}

// Discord-Konto passt zur Einladung? (username, Anzeigename oder username#1234)
function matchesDiscordUsername(invitedUsername, dUser) {
  const candidates = [
    dUser.username,
    dUser.global_name,
    dUser.discriminator && dUser.discriminator !== '0' ? `${dUser.username}#${dUser.discriminator}` : null,
  ].filter(Boolean).map((s) => s.toLowerCase());
  return candidates.includes(String(invitedUsername || '').toLowerCase());
}

// Gibt es eine offene Einladung, auf die der Discord-Nutzer passt?
// Wird beim Login geprueft, damit Konten mit offener HR-Einladung eine
// verifizierte E-Mail-Adresse benoetigen (die wird nicht mehr abgefragt).
function matchesAnyPendingInvite(dUser) {
  const rows = db.prepare(`
    SELECT discord_username FROM users WHERE status = 'invited' AND discord_username IS NOT NULL
  `).all();
  return rows.some((u) => matchesDiscordUsername(u.discord_username, dUser));
}

// Nur verifizierte E-Mails aus dem Discord-Konto verwenden. E-Mail wird nur
// mit dem Scope "identify email" uebergeben und nur dann gespeichert.
function isEmailVerified(dUser) {
  return dUser && dUser.verified === true && typeof dUser.email === 'string' && dUser.email.length > 0;
}

module.exports = {
  getAuthUrl,
  verifyState,
  exchangeCode,
  fetchDiscordUser,
  avatarUrl,
  staffIds,
  isAuthorizedDiscord,
  matchesDiscordUsername,
  matchesAnyPendingInvite,
  isEmailVerified,
  isGuildCheckEnabled,
  isInGuild,
};
