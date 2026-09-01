require('dotenv').config();

const crypto = require('crypto');

function requireEnv(key, fallback) {
  const val = process.env[key];
  if (val) return val;
  if (fallback) return fallback;
  console.error(`[FATAL] Missing required environment variable: ${key}`);
  process.exit(1);
}

function deriveDefaultSecret() {
  // Only for dev: generate a one-time random secret if none is provided
  if (process.env.NODE_ENV === 'production') {
    requireEnv('JWT_SECRET');
    requireEnv('ENCRYPTION_KEY');
  }
  const jwt = process.env.JWT_SECRET;
  const enc = process.env.ENCRYPTION_KEY;
  if (!jwt || !enc) {
    console.warn('[WARN] JWT_SECRET or ENCRYPTION_KEY not set. Using temporary random secrets (data will NOT be decryptable after restart!)');
  }
  return {
    jwt: jwt || crypto.randomBytes(32).toString('hex'),
    enc: enc || crypto.randomBytes(32).toString('hex')
  };
}

const secrets = deriveDefaultSecret();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  adminPort: parseInt(process.env.ADMIN_PORT) || 3001,
  userPort: parseInt(process.env.USER_PORT) || 3002,
  jwt: {
    secret: secrets.jwt,
    expiresIn: '7d'
  },
  secondAuth: {
    secret: process.env.SECOND_AUTH_SECRET || secrets.jwt
  },
  encryption: {
    key: secrets.enc
  },
  database: {
    url: process.env.DATABASE_URL
  },
  defaults: {
    adminUsername: process.env.DEFAULT_ADMIN_USERNAME || 'admin',
    // No default admin password for security. Must be provided via environment variable.
    adminPassword: process.env.DEFAULT_ADMIN_PASSWORD || null
  },
  log: {
    level: process.env.LOG_LEVEL || 'info'
  }
};
