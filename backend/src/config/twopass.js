const fs = require('fs');
const path = require('path');

const CONFIG_DIR = path.resolve(__dirname, '..', '..', '..', 'config');
const TWOPASS_FILE = path.join(CONFIG_DIR, 'twopass.json');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function readTwopass() {
  try {
    if (!fs.existsSync(TWOPASS_FILE)) return null;
    const raw = fs.readFileSync(TWOPASS_FILE, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[twopass] failed to read twopass.json:', err.message);
    return null;
  }
}

function isInitialized() {
  const data = readTwopass();
  return !!(data && typeof data.password === 'string' && data.password.length > 0);
}

function verifyPassword(password) {
  const data = readTwopass();
  if (!data || !data.password) return false;
  try {
    const decoded = Buffer.from(data.password, 'base64').toString('utf8');
    return decoded === password;
  } catch (err) {
    return false;
  }
}

function initializePassword(password) {
  if (isInitialized()) {
    throw new Error('二级密码已初始化，不可重复设置');
  }

  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('密码不能为空');
  }

  ensureConfigDir();
  const data = {
    password: Buffer.from(password).toString('base64'),
    initialized_at: new Date().toISOString()
  };

  fs.writeFileSync(TWOPASS_FILE, JSON.stringify(data, null, 2), 'utf8');

  // 首次初始化后设置为只读，防止运行时误写
  try {
    fs.chmodSync(TWOPASS_FILE, 0o444);
  } catch (err) {
    console.warn('[twopass] failed to set read-only mode:', err.message);
  }

  return true;
}

module.exports = {
  TWOPASS_FILE,
  isInitialized,
  verifyPassword,
  initializePassword
};
