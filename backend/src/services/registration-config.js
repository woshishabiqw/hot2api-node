/**
 * Registration configuration service.
 * Reads/writes registration settings from the database settings table,
 * falling back to environment variables when not configured.
 */
const db = require('../config/database');

const KEYS = {
  registrationEnabled: 'registration_enabled',
  captchaEnabled: 'captcha_enabled',
  emailVerificationEnabled: 'email_verification_enabled',
  approvalMode: 'registration_approval_mode',
};

function normalizeBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function normalizeApprovalMode(value) {
  if (value === 'manual') return 'manual';
  return 'auto';
}

async function getSetting(key) {
  try {
    const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
    return row ? row.value : undefined;
  } catch (err) {
    console.error('[RegistrationConfig] Failed to read setting:', key, err.message);
    return undefined;
  }
}

async function getRegistrationConfig() {
  const [enabledDb, captchaDb, emailDb, modeDb] = await Promise.all([
    getSetting(KEYS.registrationEnabled),
    getSetting(KEYS.captchaEnabled),
    getSetting(KEYS.emailVerificationEnabled),
    getSetting(KEYS.approvalMode),
  ]);

  // Backward compatibility: ALLOW_REGISTRATION env variable is only used
  // when the database setting has not been written yet.
  const envRegistration = process.env.ALLOW_REGISTRATION;
  const defaultEnabled = envRegistration === undefined || envRegistration === null || envRegistration === ''
    ? true
    : String(envRegistration).toLowerCase() === 'true';

  return {
    registrationEnabled: normalizeBoolean(enabledDb, defaultEnabled),
    captchaEnabled: normalizeBoolean(captchaDb, false),
    emailVerificationEnabled: normalizeBoolean(emailDb, false),
    approvalMode: modeDb ? normalizeApprovalMode(modeDb) : 'auto',
  };
}

async function setRegistrationConfig({
  registrationEnabled,
  captchaEnabled,
  emailVerificationEnabled,
  approvalMode,
  registration_enabled,
  captcha_enabled,
  email_verification_enabled,
  registration_approval_mode,
}) {
  const values = [];

  const enabled = registrationEnabled !== undefined ? registrationEnabled : registration_enabled;
  const captcha = captchaEnabled !== undefined ? captchaEnabled : captcha_enabled;
  const email = emailVerificationEnabled !== undefined ? emailVerificationEnabled : email_verification_enabled;
  const mode = approvalMode !== undefined ? approvalMode : registration_approval_mode;

  if (enabled !== undefined) {
    values.push([KEYS.registrationEnabled, String(enabled)]);
  }
  if (captcha !== undefined) {
    values.push([KEYS.captchaEnabled, String(captcha)]);
  }
  if (email !== undefined) {
    values.push([KEYS.emailVerificationEnabled, String(email)]);
  }
  if (mode !== undefined) {
    values.push([KEYS.approvalMode, normalizeApprovalMode(mode)]);
  }

  for (const [key, value] of values) {
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }
}

module.exports = {
  getRegistrationConfig,
  setRegistrationConfig,
  KEYS,
};
