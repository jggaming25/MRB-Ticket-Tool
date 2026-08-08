'use strict';

const webpush = require('web-push');
const { db } = require('./db');

const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@localhost';

function isConfigured() {
  return !!(vapidPublicKey && vapidPrivateKey);
}

if (isConfigured()) {
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

function saveSubscription(userId, subscription) {
  const { endpoint, keys = {} } = subscription || {};
  if (!endpoint || !keys.auth || !keys.p256dh) return false;
  db.prepare(`
    INSERT INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, endpoint) DO UPDATE SET keys_auth = excluded.keys_auth, keys_p256dh = excluded.keys_p256dh
  `).run(userId, endpoint, keys.auth, keys.p256dh);
  return true;
}

function removeSubscription(endpoint) {
  if (!endpoint) return;
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function subscriptionsOf(userId) {
  return db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
}

async function sendToUser(userId, payload) {
  if (!isConfigured() || !userId) return;
  const subs = subscriptionsOf(userId);
  if (!subs.length) return;
  const body = JSON.stringify(payload);
  for (const s of subs) {
    const sub = {
      endpoint: s.endpoint,
      keys: { auth: s.keys_auth, p256dh: s.keys_p256dh },
    };
    try {
      await webpush.sendNotification(sub, body);
    } catch (err) {
      // 404/410: Der Browser hat die Subscription verworfen (deinstalliert/abgelaufen).
      if (err.statusCode === 404 || err.statusCode === 410) {
        removeSubscription(s.endpoint);
      } else {
        console.error('Push-Fehler:', err.statusCode, err.message);
      }
    }
  }
}

module.exports = {
  isConfigured,
  saveSubscription,
  removeSubscription,
  sendToUser,
  vapidPublicKey,
};
