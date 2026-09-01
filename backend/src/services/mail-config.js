/**
 * Mail / SMTP configuration service.
 * Reads/writes SMTP settings from the database settings table.
 */
const db = require('../config/database');

const KEYS = {
  smtpHost: 'smtp_host',
  smtpPort: 'smtp_port',
  smtpSecure: 'smtp_secure',
  smtpUser: 'smtp_user',
  smtpPass: 'smtp_pass',
  smtpFrom: 'smtp_from',
};

function normalizeBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

async function getSetting(key) {
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : undefined;
  } catch (err) {
    console.error('[MailConfig] Failed to read setting:', key, err.message);
    return undefined;
  }
}

async function getMailConfig() {
  const [host, port, secure, user, pass, from] = await Promise.all([
    getSetting(KEYS.smtpHost),
    getSetting(KEYS.smtpPort),
    getSetting(KEYS.smtpSecure),
    getSetting(KEYS.smtpUser),
    getSetting(KEYS.smtpPass),
    getSetting(KEYS.smtpFrom),
  ]);

  return {
    host: host || '',
    port: port ? parseInt(port, 10) : 465,
    secure: normalizeBoolean(secure, true),
    user: user || '',
    pass: pass || '',
    from: from || '',
  };
}

async function setMailConfig({ host, port, secure, user, pass, from }) {
  const values = [];

  if (host !== undefined) values.push([KEYS.smtpHost, String(host)]);
  if (port !== undefined) values.push([KEYS.smtpPort, String(parseInt(port, 10) || 465)]);
  if (secure !== undefined) values.push([KEYS.smtpSecure, String(normalizeBoolean(secure, true))]);
  if (user !== undefined) values.push([KEYS.smtpUser, String(user)]);
  if (pass !== undefined) values.push([KEYS.smtpPass, String(pass)]);
  if (from !== undefined) values.push([KEYS.smtpFrom, String(from)]);

  for (const [key, value] of values) {
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
}

function hasRequiredConfig(config) {
  return !!(config && config.host && config.user && config.pass && config.from);
}

module.exports = {
  getMailConfig,
  setMailConfig,
  hasRequiredConfig,
  KEYS,
};
