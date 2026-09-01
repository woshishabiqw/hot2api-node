/**
 * Shared password policy validation.
 */

function validatePassword(password) {
  if (typeof password !== 'string') {
    return { valid: false, error: '密码必须是字符串' };
  }
  if (password.length < 8) {
    return { valid: false, error: '密码至少 8 个字符' };
  }
  if (!/[a-zA-Z]/.test(password)) {
    return { valid: false, error: '密码必须包含至少一个字母' };
  }
  if (!/\d/.test(password)) {
    return { valid: false, error: '密码必须包含至少一个数字' };
  }
  return { valid: true };
}

const { getRegistrationConfig } = require('../services/registration-config');

async function isRegistrationAllowed() {
  try {
    const config = await getRegistrationConfig();
    return config.registrationEnabled;
  } catch (err) {
    console.error('[PasswordPolicy] Failed to read registration config:', err.message);
    // Fall back to environment variable on error.
    const env = process.env.ALLOW_REGISTRATION;
    if (env === undefined || env === null || env === '') return true;
    return String(env).toLowerCase() === 'true';
  }
}

module.exports = {
  validatePassword,
  isRegistrationAllowed,
};
