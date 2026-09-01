/**
 * Server startup configuration loader.
 * Reads {projectRoot}/config/server.json (re/start effective).
 */

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', '..', '..', 'config', 'server.json');

const DEFAULTS = {
  ipv4: ['0.0.0.0'],
  ipv6: ['::'],
  ports: {
    api: 3000,
    admin: 3001,
    user: 3002,
  },
  trust_proxy: true,
  watchdog: {
    maxMemoryMB: 2048,
  },
};

function loadServerConfig() {
  let fileConfig = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[server-config] Failed to load config/server.json:', e.message);
  }

  const cfg = {
    ipv4: fileConfig.ipv4 || DEFAULTS.ipv4,
    ipv6: fileConfig.ipv6 || DEFAULTS.ipv6,
    ports: { ...DEFAULTS.ports, ...(fileConfig.ports || {}) },
    trust_proxy: fileConfig.trust_proxy !== undefined ? fileConfig.trust_proxy : DEFAULTS.trust_proxy,
    watchdog: { ...DEFAULTS.watchdog, ...(fileConfig.watchdog || {}) },
  };

  // Sanitize IP lists: ignore empty strings; treat null/undefined as defaults.
  if (!Array.isArray(cfg.ipv4) || cfg.ipv4.length === 0 || cfg.ipv4.every(ip => !ip)) cfg.ipv4 = DEFAULTS.ipv4;
  if (!Array.isArray(cfg.ipv6) || cfg.ipv6.length === 0 || cfg.ipv6.every(ip => !ip)) cfg.ipv6 = DEFAULTS.ipv6;

  // Normalize 'all' to the catch-all address for each family.
  cfg.ipv4 = cfg.ipv4.map(ip => (ip === 'all' ? '0.0.0.0' : ip)).filter(Boolean);
  cfg.ipv6 = cfg.ipv6.map(ip => (ip === 'all' ? '::' : ip)).filter(Boolean);

  return cfg;
}

module.exports = { loadServerConfig, DEFAULTS };
