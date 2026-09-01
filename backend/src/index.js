// ====== INDEX.JS VERSION 2025-06-01-FIXED ======
require('dotenv').config();
console.log('[VERSION] INDEX.JS RELOADED WITH FIX');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Crash log: only ERROR level (console.error) is persisted.
// User-level console.log goes to stdout only, not to crash-monitor.log.
const crashLogPath = path.join(__dirname, '..', 'logs', 'crash-monitor.log');
let logQueue = [];
let logWriting = false;
const MAX_LOG_QUEUE = 500;        // hard cap: drop old entries if queue backs up
const MAX_CRASH_LOG_MB = 50;      // truncate log if it grows too large

function ensureCrashLogDir() {
  try {
    const dir = path.dirname(crashLogPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
}

function truncateCrashLogIfNeeded() {
  ensureCrashLogDir();
  try {
    const stats = fs.statSync(crashLogPath);
    if (stats.size > MAX_CRASH_LOG_MB * 1024 * 1024) {
      fs.writeFileSync(crashLogPath, `[${new Date().toISOString()}] [INFO] Crash log truncated (was ${(stats.size / 1048576).toFixed(1)}MB)\n`);
    }
  } catch (e) {}
}

function flushLogQueue() {
  if (logWriting || logQueue.length === 0) return;
  logWriting = true;
  const lines = logQueue.join('');
  logQueue = [];
  fs.appendFile(crashLogPath, lines, (err) => {
    logWriting = false;
    if (err) {
      // Silently drop to avoid infinite loop
    }
    flushLogQueue();
  });
}

function logToCrash(...args) {
  // Protect against memory leak if fs.appendFile is stalled
  if (logQueue.length >= MAX_LOG_QUEUE) {
    logQueue.shift(); // drop oldest
  }
  const line = args.map(a => {
    if (typeof a === 'object') {
      try {
        return JSON.stringify(a);
      } catch (e) {
        return '[unserializable]';
      }
    }
    return String(a);
  }).join(' ');
  logQueue.push(`[${new Date().toISOString()}] ${line}\n`);
  flushLogQueue();
}

const origLog = console.log;
const origErr = console.error;

// User-level logs: stdout only, NOT written to crash-monitor.log
console.log = (...args) => {
  try { origLog(...args); } catch (e) {
    // stdout pipe may be broken (EPIPE), silently drop
  }
};

// ERROR-level logs: write to crash-monitor.log + stderr
console.error = (...args) => {
  logToCrash(...args);
  try { origErr(...args); } catch (e) {
    // stderr pipe may be broken (EPIPE), silently drop
  }
};

// Force stdout/stderr to flush immediately on Windows so we don't lose crash logs
if (process.stdout && process.stdout._handle && process.stdout._handle.setBlocking) {
  process.stdout._handle.setBlocking(true);
}
if (process.stderr && process.stderr._handle && process.stderr._handle.setBlocking) {
  process.stderr._handle.setBlocking(true);
}

// Truncate crash log on startup so it doesn't grow forever
truncateCrashLogIfNeeded();

// Generate diagnostic report on fatal error / uncaught exception
process.report.reportOnFatalError = true;
process.report.reportOnUncaughtException = true;
process.report.reportOnSignal = true;
process.report.directory = path.join(__dirname, '..', 'logs', 'reports');
try {
  fs.mkdirSync(process.report.directory, { recursive: true });
} catch (e) {}

// External heartbeat: sync write every 10s so we know exactly when it stops
const heartbeatPath = path.join(__dirname, '..', 'logs', 'heartbeat.txt');
setInterval(() => {
  try {
    fs.writeFileSync(heartbeatPath, new Date().toISOString());
  } catch (e) {}
}, 10000);
fs.writeFileSync(heartbeatPath, new Date().toISOString());

// Global process state - must be declared before any process.on handlers
let activeRequests = 0;
let shuttingDown = false;

// Global error handlers to prevent process crash on unhandled errors
// CRITICAL: do NOT use console.error here because if stdout pipe is broken
// (EPIPE), console.error will throw again, causing infinite recursion.
process.on('uncaughtException', (err) => {
  ensureCrashLogDir();
  try {
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] [FATAL] Uncaught Exception: ${err?.message} | code: ${err?.code}\n${err?.stack || ''}\n`);
  } catch (e) {}
  try { console.error('[FATAL] Uncaught Exception:', err.message, '| code:', err.code); } catch (e) {}
  // CRITICAL: Never continue after uncaughtException — internal state is corrupt.
  // Exit immediately and let the watchdog auto-restart us.
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  const msg = reason?.message || String(reason);
  const code = reason?.code;
  // Business errors (DB constraint violations, bad input, etc.) should NOT kill the process.
  // Only truly fatal errors (memory, syntax, missing modules) should exit.
  const isBusinessError = code === '22003' || code === '23505' || code === '23503' ||
    msg?.includes('数字字段溢出') || msg?.includes('numeric_value_out_of_range') ||
    msg?.includes('unique constraint') || msg?.includes('foreign key constraint') ||
    msg?.includes('Connection terminated') || msg?.includes('connection timeout') ||
    msg?.includes('timeout exceeded when trying to connect') ||
    msg?.includes('sorry, too many clients already') ||
    msg?.includes('ECONNREFUSED') || msg?.includes('ECONNRESET') || msg?.includes('EPIPE') ||
    msg?.includes('socket hang up') || msg?.includes('aborted');
  ensureCrashLogDir();
  try {
    fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] [${isBusinessError ? 'WARN' : 'FATAL'}] Unhandled Rejection: ${msg} | code: ${code}\n`);
  } catch (e) {}
  if (isBusinessError) {
    try { console.error('[WARN] Business error (not fatal):', msg, '| code:', code); } catch (e) {}
    return; // keep running
  }
  try { console.error('[FATAL] Unhandled Rejection:', reason); } catch (e) {}
  process.exit(1);
});

// Catch any process exit / signal so we know WHY it stopped
process.on('exit', (code) => {
  const reason = shuttingDown ? 'graceful shutdown' : 'unexpected';
  console.error(`[Process] EXIT event fired with code ${code} (${reason})`);
});
process.on('SIGTERM', () => {
  console.error('[Process] SIGTERM received');
  shuttingDown = true;
  process.exit(0);
});
process.on('SIGINT', () => {
  console.error('[Process] SIGINT received');
  shuttingDown = true;
  process.exit(0);
});
process.on('SIGHUP', () => {
  // On Windows, SIGHUP is often sent when the parent terminal/ConPTY crashes
  // or the shell session is recycled. Do NOT exit: the gateway should survive
  // terminal detachment so that one crashing console does not kill the server.
  console.error('[Process] SIGHUP received, ignoring (terminal detached)');
});

// Memory & health monitor – prints every 60s so we can spot leaks
setInterval(() => {
  const mem = process.memoryUsage();
  if (process.env.LOG_LEVEL === 'debug') console.log(`[Health] Memory  RSS:${(mem.rss/1048576).toFixed(1)}MB  Heap:${(mem.heapUsed/1048576).toFixed(1)}/${(mem.heapTotal/1048576).toFixed(1)}MB  Ext:${(mem.external/1048576).toFixed(1)}MB  Concurrency:${activeRequests}`);
}, 60000);

// Event Loop Lag monitor – detects event-loop blocking (e.g. db.export sync writes)
let lastEventLoopCheck = process.hrtime.bigint();
let currentEventLoopLagMs = 0;
const EVENT_LOOP_LAG_THRESHOLD = parseInt(process.env.EVENT_LOOP_LAG_THRESHOLD) || 1000;
setInterval(() => {
  const now = process.hrtime.bigint();
  const expected = 5000n * 1000000n; // 5s in nanoseconds
  const actual = now - lastEventLoopCheck;
  const lagMs = Number(actual - expected) / 1000000;
  currentEventLoopLagMs = Math.max(0, lagMs);
  if (lagMs > 500) {
    console.error(`[Health] EVENT LOOP LAG: ${lagMs.toFixed(0)}ms — main thread is blocked!`);
  }
  lastEventLoopCheck = now;
}, 5000);

// Global concurrency limit & overload protection
const MAX_CONCURRENT_REQUESTS = parseInt(process.env.MAX_CONCURRENT) || 500;

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { createStream } = require('rotating-file-stream');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const config = require('./config/settings');
const { loadServerConfig } = require('./config/server-config');
const serverConfig = loadServerConfig();
const net = require('net');
const os = require('os');
const { initDatabase, get: dbGet, saveDatabase } = require('./config/database');
const { initRedis } = require('./config/redis');

const openaiRoutes = require('./routes/openai');
const anthropicRoutes = require('./routes/anthropic');
const geminiRoutes = require('./routes/gemini');
const adminRoutes = require('./routes/admin');
const userRoutes = require('./routes/user');
const workspaceRoutes = require('./routes/workspaces');
const chatRoutes = require('./routes/chat');
const webchatAdminRoutes = require('./routes/admin/webchat');
const { router: billingRouter, callbackRouter: billingCallbackRouter, stripeWebhookRouter: billingStripeWebhookRouter } = require('./routes/billing');
const authRateLimitMiddleware = require('./middleware/auth-rate-limit');
const apiKeyMiddleware = require('./middleware/apikey');
const rateLimitMiddleware = require('./middleware/rate-limit');
const userRateLimitMiddleware = require('./middleware/user-rate-limit');
const { securityHeaders, sanitizeInput, sqlInjectionGuard } = require('./middleware/security');
const { ipBlacklistMiddleware } = require('./middleware/ip-blacklist');
const ipRateLimitMiddleware = require('./middleware/ip-rate-limit');
const requireSecondAuthForMutations = require('./middleware/require-second-auth');
const { createAdminRateLimit } = require('./middleware/admin-rate-limit');
// Second-auth middleware removed for billing/payment channels per requirement
const probeService = require('./services/probe');
const logManagementService = require('./services/log-management');
const smartRoutingService = require('./services/smart-routing');
const invoiceService = require('./services/invoice');
const { authMiddleware, adminMiddleware } = require('./middleware/auth');
const cacheService = require('./services/cache');
const transitScanner = require('./services/transit-scanner');
const { getRegistrationConfig } = require('./services/registration-config');

function isIPv6Host(host) {
  return net.isIPv6(host);
}

function getLocalIPAddresses() {
  const ips = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      for (const iface of entries || []) {
        if (iface.family === 'IPv4' && !iface.internal) {
          ips.push(iface.address);
        }
      }
    }
  } catch (e) {}
  return ips.length ? ips : ['127.0.0.1'];
}

function listenOnHosts(app, port, hosts, label) {
  const servers = [];
  const seen = new Set();
  for (const rawHost of hosts) {
    const host = rawHost?.trim();
    if (!host) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const server = app.listen({ port, host, ipv6Only: isIPv6Host(host) }, () => {
        console.log(`[Server] ${label} listening on ${host}:${port}`);
      });
      server.on('error', (err) => {
        console.error(`[Server] ${label} error on ${host}:${port}:`, err.message, '| code:', err.code);
        if (err.code === 'EADDRINUSE') {
          console.error(`[WARN] ${label} port ${port} is already in use.`);
        }
      });
      servers.push(server);
    } catch (err) {
      console.error(`[Server] Failed to bind ${label} on ${host}:${port}:`, err.message);
    }
  }
  return servers;
}

function closeServers(servers) {
  for (const s of servers) {
    try { s.close(); } catch (e) {}
  }
}

async function backfillUserDailyModelStats() {
  const db = require('./config/database');
  try {
    // Only run on first startup when the aggregation table is empty.
    // The write path (stats-buffer) keeps it up-to-date afterwards.
    // For external data injection, use scripts/backfill-daily-stats.js.
    const hasData = await db.get('SELECT COUNT(*) as count FROM user_daily_model_stats');
    if ((hasData?.count || 0) > 0) return;

    const hasLogs = await db.get('SELECT COUNT(*) as count FROM request_logs');
    if ((hasLogs?.count || 0) === 0) return;

    // Dashboard only uses 7d/30d ranges, so we only need the last 30 days.
    // This keeps startup backfill fast even for huge historical tables.
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    console.log('[Startup] Backfilling user_daily_model_stats (last 30 days)...');
    await db.run(`
      INSERT INTO user_daily_model_stats (user_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT user_id, created_at::date::text as date, COALESCE(model, 'unknown'), COUNT(*) as requests,
             SUM(total_tokens) as tokens, SUM(cost) as cost,
             SUM(latency_ms) as latency_ms_sum, COUNT(*) as latency_ms_count
      FROM request_logs
      WHERE user_id IS NOT NULL AND created_at >= $1::date
      GROUP BY user_id, created_at::date, COALESCE(model, 'unknown')
      ON CONFLICT (user_id, date, model) DO UPDATE SET
        requests = user_daily_model_stats.requests + EXCLUDED.requests,
        tokens = user_daily_model_stats.tokens + EXCLUDED.tokens,
        cost = user_daily_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = user_daily_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = user_daily_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `, [sinceStr]);
    const after = await db.get('SELECT COUNT(*) as count FROM user_daily_model_stats');
    console.log(`[Startup] Backfilled ${after?.count || 0} user_daily_model_stats rows`);
  } catch (e) {
    console.error('[Startup] Failed to backfill user_daily_model_stats:', e?.message || e);
  }
}

async function backfillUserHourlyModelStats() {
  const db = require('./config/database');
  try {
    const hasData = await db.get('SELECT COUNT(*) as count FROM user_hourly_model_stats');
    if ((hasData?.count || 0) > 0) return;

    const hasLogs = await db.get('SELECT COUNT(*) as count FROM request_logs');
    if ((hasLogs?.count || 0) === 0) return;

    // Dashboard uses 6h/24h ranges, backfill last 48 hours to cover boundary cases.
    const since = new Date();
    since.setHours(since.getHours() - 48);
    const sinceStr = since.toISOString();

    console.log('[Startup] Backfilling user_hourly_model_stats (last 48 hours)...');
    await db.run(`
      INSERT INTO user_hourly_model_stats (user_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT user_id,
             to_char(created_at, 'YYYY-MM-DD HH24:00') as hour,
             COALESCE(model, 'unknown'),
             COUNT(*) as requests,
             SUM(total_tokens) as tokens,
             SUM(cost) as cost,
             SUM(latency_ms) as latency_ms_sum,
             COUNT(*) as latency_ms_count
      FROM request_logs
      WHERE user_id IS NOT NULL AND created_at >= $1::timestamp
      GROUP BY user_id, to_char(created_at, 'YYYY-MM-DD HH24:00'), COALESCE(model, 'unknown')
      ON CONFLICT (user_id, hour, model) DO UPDATE SET
        requests = user_hourly_model_stats.requests + EXCLUDED.requests,
        tokens = user_hourly_model_stats.tokens + EXCLUDED.tokens,
        cost = user_hourly_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = user_hourly_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = user_hourly_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `, [sinceStr]);
    const after = await db.get('SELECT COUNT(*) as count FROM user_hourly_model_stats');
    console.log(`[Startup] Backfilled ${after?.count || 0} user_hourly_model_stats rows`);
  } catch (e) {
    console.error('[Startup] Failed to backfill user_hourly_model_stats:', e?.message || e);
  }
}

async function backfillSourceDailyModelStats() {
  const db = require('./config/database');
  try {
    const hasData = await db.get('SELECT COUNT(*) as count FROM source_daily_model_stats');
    if ((hasData?.count || 0) > 0) return;

    const hasLogs = await db.get('SELECT COUNT(*) as count FROM request_logs');
    if ((hasLogs?.count || 0) === 0) return;

    const since = new Date();
    since.setDate(since.getDate() - 30);
    const sinceStr = since.toISOString().slice(0, 10);

    console.log('[Startup] Backfilling source_daily_model_stats (last 30 days)...');
    await db.run(`
      INSERT INTO source_daily_model_stats (source_id, date, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT source_id, created_at::date::text as date, COALESCE(model, 'unknown'),
             COUNT(*) as requests, SUM(total_tokens) as tokens, SUM(cost) as cost,
             SUM(latency_ms) as latency_ms_sum, COUNT(*) as latency_ms_count
      FROM request_logs
      WHERE source_id IS NOT NULL AND created_at >= $1::date
      GROUP BY source_id, created_at::date, COALESCE(model, 'unknown')
      ON CONFLICT (source_id, date, model) DO UPDATE SET
        requests = source_daily_model_stats.requests + EXCLUDED.requests,
        tokens = source_daily_model_stats.tokens + EXCLUDED.tokens,
        cost = source_daily_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = source_daily_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = source_daily_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `, [sinceStr]);
    const after = await db.get('SELECT COUNT(*) as count FROM source_daily_model_stats');
    console.log(`[Startup] Backfilled ${after?.count || 0} source_daily_model_stats rows`);
  } catch (e) {
    console.error('[Startup] Failed to backfill source_daily_model_stats:', e?.message || e);
  }
}

async function backfillSourceHourlyModelStats() {
  const db = require('./config/database');
  try {
    const hasData = await db.get('SELECT COUNT(*) as count FROM source_hourly_model_stats');
    if ((hasData?.count || 0) > 0) return;

    const hasLogs = await db.get('SELECT COUNT(*) as count FROM request_logs');
    if ((hasLogs?.count || 0) === 0) return;

    const since = new Date();
    since.setHours(since.getHours() - 48);
    const sinceStr = since.toISOString();

    console.log('[Startup] Backfilling source_hourly_model_stats (last 48 hours)...');
    await db.run(`
      INSERT INTO source_hourly_model_stats (source_id, hour, model, requests, tokens, cost, latency_ms_sum, latency_ms_count)
      SELECT source_id,
             to_char(created_at, 'YYYY-MM-DD HH24:00') as hour,
             COALESCE(model, 'unknown'),
             COUNT(*) as requests,
             SUM(total_tokens) as tokens,
             SUM(cost) as cost,
             SUM(latency_ms) as latency_ms_sum,
             COUNT(*) as latency_ms_count
      FROM request_logs
      WHERE source_id IS NOT NULL AND created_at >= $1::timestamp
      GROUP BY source_id, to_char(created_at, 'YYYY-MM-DD HH24:00'), COALESCE(model, 'unknown')
      ON CONFLICT (source_id, hour, model) DO UPDATE SET
        requests = source_hourly_model_stats.requests + EXCLUDED.requests,
        tokens = source_hourly_model_stats.tokens + EXCLUDED.tokens,
        cost = source_hourly_model_stats.cost + EXCLUDED.cost,
        latency_ms_sum = source_hourly_model_stats.latency_ms_sum + EXCLUDED.latency_ms_sum,
        latency_ms_count = source_hourly_model_stats.latency_ms_count + EXCLUDED.latency_ms_count,
        updated_at = CURRENT_TIMESTAMP
    `, [sinceStr]);
    const after = await db.get('SELECT COUNT(*) as count FROM source_hourly_model_stats');
    console.log(`[Startup] Backfilled ${after?.count || 0} source_hourly_model_stats rows`);
  } catch (e) {
    console.error('[Startup] Failed to backfill source_hourly_model_stats:', e?.message || e);
  }
}

const startServer = async () => {
  await initDatabase();
  await transitScanner.ensureTable();
  await backfillUserDailyModelStats();
  await backfillUserHourlyModelStats();
  await backfillSourceDailyModelStats();
  await backfillSourceHourlyModelStats();
  // Redis is optional: don't block server startup if the Redis server is down.
  // cacheService will fall back to memory caching in that case.
  try {
    await Promise.race([
      initRedis(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Redis init timeout')), 5000))
    ]);
  } catch (e) {
    console.warn('[Startup] Redis init skipped:', e?.message);
  }
  try {
    await Promise.race([
      cacheService.initRedis(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Cache init timeout')), 5000))
    ]);
  } catch (e) {
    console.warn('[Startup] Cache init skipped:', e?.message);
  }

  // Reset all source concurrent counters on startup to fix potential leaks from crashes
  try {
    const db = require('./config/database');
    await db.run('UPDATE sources SET current_concurrent = 0');
    console.log('[Startup] Reset all source concurrent counters to 0');
  } catch (e) {
    console.error('[Startup] Failed to reset concurrent counters:', e.message);
  }

  // ========== API Server (port 3000) ==========
  const apiApp = express();
  apiApp.set('trust proxy', serverConfig.trust_proxy);
  apiApp.use(ipBlacklistMiddleware);
  apiApp.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  }));

  // CORS: restrict to known origins (use configured frontend ports)
  const adminOrigin = `http://localhost:${serverConfig.ports.admin}`;
  const userOrigin = `http://localhost:${serverConfig.ports.user}`;
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : [adminOrigin, userOrigin, `http://localhost:3004`, 'http://localhost:5173', 'http://localhost:5174'];
  apiApp.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, etc.)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      console.warn('[CORS] Blocked origin:', origin);
      callback(null, false);
    },
    credentials: true
  }));

  // HTTP request log with daily rotation
  const accessLogStream = createStream('access.log', {
    interval: '1d',
    path: path.join(__dirname, '..', 'logs'),
    size: '10M',
    compress: 'gzip',
    maxFiles: 7
  });
  apiApp.use(morgan('combined', { stream: accessLogStream }));
  // Stripe webhook must receive the raw body for signature verification.
  // Skip the global JSON parser for that path so the router's express.raw() can consume the stream.
  const jsonParser = express.json({ limit: '10mb' });
  apiApp.use((req, res, next) => {
    if (req.path === '/billing/stripe-webhook') return next();
    jsonParser(req, res, next);
  });
  apiApp.use(ipRateLimitMiddleware);
  apiApp.use(securityHeaders);
  // Request-level timeout: drop slow connections after 130s (slightly above axios 120s)
  apiApp.use((req, res, next) => {
    req.setTimeout(130000);
    res.setTimeout(130000);
    next();
  });

  // Overload protection middleware: reject when too many active requests or event loop is blocked
  apiApp.use((req, res, next) => {
    if (shuttingDown) {
      return res.status(503).json({ error: { message: 'Server is shutting down', type: 'service_unavailable' } });
    }
    // Health checks must stay available so load balancers / watchdog know the process is alive
    if (req.path.startsWith('/health')) return next();
    if (currentEventLoopLagMs >= EVENT_LOOP_LAG_THRESHOLD) {
      console.error(`[Overload] Rejecting request: event loop lag ${currentEventLoopLagMs.toFixed(0)}ms >= threshold ${EVENT_LOOP_LAG_THRESHOLD}ms`);
      return res.status(503).json({ error: { message: 'Server overloaded, please retry later', type: 'service_unavailable' } });
    }
    if (activeRequests >= MAX_CONCURRENT_REQUESTS) {
      console.error(`[Overload] Rejecting request: active=${activeRequests} >= max=${MAX_CONCURRENT_REQUESTS}`);
      return res.status(503).json({ error: { message: 'Server overloaded, please retry later', type: 'service_unavailable' } });
    }
    activeRequests++;
    res.on('finish', () => { activeRequests = Math.max(0, activeRequests - 1); });
    res.on('close', () => { activeRequests = Math.max(0, activeRequests - 1); });
    next();
  });

  apiApp.get('/', (req, res) => {
    res.json({
      name: 'Fuck Gateway',
      version: '1.0.0',
      endpoints: {
        openai: {
          'POST /v1/chat/completions': 'Chat completions (OpenAI compatible)',
          'POST /v1/completions': 'Completions (OpenAI compatible)',
          'GET /v1/models': 'List available models'
        },
        anthropic: {
          'POST /v1/messages': 'Messages (Anthropic compatible)'
        },
        gemini: {
          'GET /v1beta/models': 'List available models (Gemini compatible)',
          'POST /v1beta/models/{model}:generateContent': 'Generate content (Gemini compatible)',
          'POST /v1beta/models/{model}:streamGenerateContent': 'Stream generate content (Gemini compatible)'
        }
      }
    });
  });

  // Health check endpoints (no auth, before sanitization middleware)
  apiApp.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  apiApp.get('/health/ready', async (req, res) => {
    try {
      await dbGet('SELECT 1');
      res.status(200).json({ status: 'ready', db: 'connected', timestamp: new Date().toISOString() });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', db: 'disconnected', error: err.message });
    }
  });

  apiApp.get('/health/live', (req, res) => {
    res.status(200).json({
      status: 'alive',
      pid: process.pid,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    });
  });

  // Swagger API Docs (no auth, before input sanitization)
  const swaggerOptions = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'Fuck Gateway API',
        version: '1.0.0',
        description: 'API Gateway for LLM services'
      },
      servers: [
        { url: `http://localhost:${serverConfig.ports.api}`, description: 'Local server' }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT'
          }
        }
      }
    },
    apis: ['./src/routes/*.js']
  };
  const swaggerSpec = swaggerJsdoc(swaggerOptions);
  apiApp.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

  // Direct routes for clients that don't send /v1 prefix (e.g. some IDE integrations)
  const proxyService = require('./services/proxy');
  apiApp.post('/messages', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, async (req, res) => {
    try {
      await proxyService.proxyChat(req, res, 'anthropic');
    } catch (err) {
      const errMsg = err?.message || 'Upstream connection failed';
      console.error('[Route] /messages handler error:', errMsg);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: errMsg, type: 'internal_error' } });
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  });
  apiApp.post('/chat/completions', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, async (req, res) => {
    try {
      await proxyService.proxyChat(req, res, 'openai');
    } catch (err) {
      const errMsg = err?.message || 'Upstream connection failed';
      console.error('[Route] /chat/completions handler error:', errMsg);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: errMsg, type: 'internal_error' } });
      } else {
        try { res.end(); } catch (e) {}
      }
    }
  });

  apiApp.use('/v1', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, openaiRoutes, anthropicRoutes);

  // Anthropic-compatible route prefix for clients that expect /anthropic base URL
  // Mount both openai and anthropic routes so GET /models works too
  apiApp.use('/anthropic/v1', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, openaiRoutes, anthropicRoutes);

  // Trae IDE and some clients use /anthropic directly without /v1
  apiApp.use('/anthropic', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, openaiRoutes, anthropicRoutes);

  apiApp.use('/v1beta', (req, res, next) => {
    if (req.method === 'GET') return next();
    apiKeyMiddleware(req, res, next);
  }, rateLimitMiddleware, userRateLimitMiddleware, geminiRoutes);

  // Billing: public callbacks first (no auth — third-party payment gateways).
  // These must run BEFORE sanitizeInput/sqlInjectionGuard so the raw form bodies
  // and signatures (Alipay/Stripe) are not HTML-escaped or rejected.
  apiApp.use('/billing', billingStripeWebhookRouter);          // Stripe webhook with raw body
  apiApp.use('/billing', billingCallbackRouter);

  // Apply input sanitization and SQL injection guard to non-proxy routes only
  // (Proxy routes pass through raw API payloads that must not be modified)
  apiApp.use(sanitizeInput);
  apiApp.use(sqlInjectionGuard);

  // Stricter rate limiting for high-impact admin endpoints
  const criticalAdminRateLimit = createAdminRateLimit({
    perUser: 5,
    perIp: 10,
    windowMs: 60000,
    message: '关键操作请求过于频繁，请稍后再试',
  });
  apiApp.use('/admin/database/execute', criticalAdminRateLimit);
  apiApp.use('/admin/database/init', criticalAdminRateLimit);
  apiApp.use('/admin/init-database', criticalAdminRateLimit);
  apiApp.use('/admin/server-config', criticalAdminRateLimit);

  apiApp.use('/admin/webchat', authMiddleware, adminMiddleware, webchatAdminRoutes);
  apiApp.use('/admin', authMiddleware, adminMiddleware, adminRoutes);
  // Rate limit auth endpoints
  apiApp.use('/auth/login', authRateLimitMiddleware);
  apiApp.use('/auth/register', authRateLimitMiddleware);
  apiApp.use('/auth', userRoutes);
  apiApp.use('/user', userRoutes);
  apiApp.use('/chat', chatRoutes);
  apiApp.use('/workspaces', workspaceRoutes);
  // Billing authenticated routes (callback routes are mounted earlier)
  apiApp.use('/billing', authMiddleware, billingRouter);
  apiApp.use('/payment-gateway', authMiddleware, require('./routes/payment-gateway'));

  apiApp.use((err, req, res, next) => {
    try {
      // Defensive: err may be null, undefined, or a primitive
      const safeErr = err || {};
      // Body-parser JSON SyntaxError → 400 Bad Request (client sent malformed JSON)
      const isClientError = safeErr instanceof SyntaxError &&
        (safeErr.status === 400 || safeErr.statusCode === 400 || ('body' in safeErr));
      const status = isClientError ? 400 : 500;
      const type = isClientError ? 'invalid_request_error' : 'internal_error';
      const errMsg = safeErr.message || 'Internal server error';
      console.error(`[${status}] ${req.method} ${req.path}:`, errMsg);
      if (!isClientError && safeErr.stack) console.error(safeErr.stack);
      const message = isClientError
        ? errMsg
        : (process.env.NODE_ENV === 'production'
          ? 'Internal server error'
          : errMsg);
      if (!res.headersSent) {
        res.status(status).json({ error: { message, type } });
      }
    } catch (handlerErr) {
      console.error('[FATAL] Global error handler crashed:', handlerErr);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: 'Internal server error', type: 'internal_error' } });
      }
    }
  });

  // ========== Start API Server ==========
  // Start model probe service
  probeService.start();
  smartRoutingService.start();
  logManagementService.startPeriodicTrim();
  invoiceService.startAutoReviewProcessor();
  invoiceService.startInvoiceFileCleanup();

  const apiHosts = [...serverConfig.ipv4, ...serverConfig.ipv6];
  const apiServers = listenOnHosts(apiApp, serverConfig.ports.api, apiHosts, 'API');
  const localIPs = getLocalIPAddresses();
  const apiPort = serverConfig.ports.api;
  const adminPort = serverConfig.ports.admin;
  const userPort = serverConfig.ports.user;

  if (apiServers.length > 0) {
    const ipLines = localIPs.map(ip => `    API:     http://${ip}:${apiPort}`).join('\n');
    const adminLines = (process.env.NODE_ENV === 'production' || process.env.SERVE_FRONTEND === 'true')
      ? localIPs.map(ip => `    Admin:   http://${ip}:${adminPort}`).join('\n')
      : '';
    const userLines = (process.env.NODE_ENV === 'production' || process.env.SERVE_FRONTEND === 'true')
      ? localIPs.map(ip => `    User:    http://${ip}:${userPort}`).join('\n')
      : '';
    console.log(`
  ==================================================
         Fuck Gateway - Running
  ==================================================
  Access URLs (LAN):
${ipLines}
${adminLines ? adminLines + '\n' : ''}${userLines ? userLines + '\n' : ''}  Localhost:
    API:     http://localhost:${apiPort}
    OpenAI:  http://localhost:${apiPort}/v1
    Admin:   http://localhost:${adminPort}
    User:    http://localhost:${userPort}
  ==================================================
    `);
    // Notify any parent watchdog that the process is ready (no-op under plain Node)
    if (typeof process.send === 'function') process.send('ready');
  }
  for (const s of apiServers) {
    s.keepAliveTimeout = 120000; // 120s, avoid ECONNRESET on connection reuse
    s.headersTimeout = 121000;
    // Limit total connections to prevent file-descriptor exhaustion under high load
    s.maxConnections = 2000;
    s.on('clientError', (err, socket) => {
      console.error('[Server] Client error:', err.message);
      if (socket.writable) {
        try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
      }
    });
  }

  // Graceful shutdown: stop accepting new requests, wait for active ones to finish
  const allServers = [...apiServers];
  const gracefulShutdown = (signal) => {
    console.error(`[Process] ${signal} received, starting graceful shutdown...`);
    shuttingDown = true;
    closeServers(allServers);
    console.error('[Process] Servers closed, no new connections accepted');
    // PostgreSQL persists automatically; saveDatabase is a no-op kept for compatibility
    if (saveDatabase) {
      try { saveDatabase(); } catch (e) { console.error('[Process] Failed to save DB during shutdown:', e.message); }
    }
    // Force exit after shutdown timeout even if requests are still active
    const shutdownTimeout = setTimeout(() => {
      console.error(`[Process] Forced exit: ${activeRequests} requests still active after timeout`);
      process.exit(1);
    }, 12000);
    shutdownTimeout.unref();

    const checkActive = setInterval(() => {
      if (activeRequests <= 0) {
        clearInterval(checkActive);
        console.error('[Process] All requests finished, exiting cleanly');
        process.exit(0);
      }
    }, 500);
  };

  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGHUP');
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  // Ignore SIGHUP to survive terminal/ConPTY crashes (Windows) and SSH disconnects.
  process.on('SIGHUP', () => console.error('[Process] SIGHUP received, ignoring.'));

  // Only serve frontend static files in production mode.
  // In dev mode, Vite dev servers handle the frontends on their own ports.
  if (process.env.NODE_ENV === 'production' || process.env.SERVE_FRONTEND === 'true') {
    // Inject registration config into the served index.html so the frontend can render
    // captcha/login settings synchronously without a visible "pop-in" after an API call.
    const indexHtmlCache = new Map();
    function generateNonce() {
      return crypto.randomBytes(16).toString('base64');
    }
    async function renderSpaIndexHtml(distPath, nonce) {
      const indexPath = path.join(distPath, 'index.html');
      let cached = indexHtmlCache.get(distPath);
      try {
        const stats = fs.statSync(indexPath);
        const mtimeMs = stats.mtimeMs;
        if (!cached || cached.mtimeMs !== mtimeMs) {
          const html = fs.readFileSync(indexPath, 'utf8');
          cached = { html, mtimeMs };
          indexHtmlCache.set(distPath, cached);
        }
      } catch (err) {
        if (cached) {
          console.warn(`[Frontend] Failed to stat ${indexPath}, serving cached index.html`);
        } else {
          throw err;
        }
      }
      const regConfig = await getRegistrationConfig();
      const configScript = `<script nonce="${nonce}">window.__REGISTRATION_CONFIG__=${JSON.stringify(regConfig)}</script>`;
      return cached.html.replace(/<\/head>/i, `${configScript}</head>`);
    }

    // ========== Admin Frontend (port 3001) ==========
    const adminApp = express();
    adminApp.set('trust proxy', serverConfig.trust_proxy);
    adminApp.use(helmet({ contentSecurityPolicy: false }));
    adminApp.use(cors({ origin: allowedOrigins, credentials: true }));
    adminApp.use('/api', (req, res) => {
      const rewritten = req.originalUrl.replace(/^\/api/, '') || '/';
      req.url = rewritten;
      apiApp.handle(req, res);
    });
    const adminDistPath = path.join(__dirname, '../../frontend-admin/dist');
    adminApp.use(express.static(adminDistPath, {
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }));
    adminApp.get('*', async (req, res) => {
      try {
        const nonce = generateNonce();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Type', 'text/html');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.alipay.com https://*.alipaydev.com; object-src 'none'; upgrade-insecure-requests;"
        );
        const html = await renderSpaIndexHtml(adminDistPath, nonce);
        res.send(html);
      } catch (err) {
        console.error('[Frontend] Failed to render admin index.html:', err.message);
        res.status(500).send('Internal server error');
      }
    });

    // ========== User Frontend (port 3002) ==========
    const userApp = express();
    userApp.set('trust proxy', serverConfig.trust_proxy);
    userApp.use(helmet({ contentSecurityPolicy: false }));
    userApp.use(cors({ origin: allowedOrigins, credentials: true }));
    userApp.use('/api', (req, res) => {
      const rewritten = req.originalUrl.replace(/^\/api/, '') || '/';
      req.url = rewritten;
      apiApp.handle(req, res);
    });
    const userDistPath = path.join(__dirname, '../../frontend-user/dist');
    userApp.use(express.static(userDistPath, {
      index: false,
      setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }));
    userApp.get('*', async (req, res) => {
      try {
        const nonce = generateNonce();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        res.setHeader('Content-Type', 'text/html');
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'nonce-" + nonce + "'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://*.alipay.com https://*.alipaydev.com; object-src 'none'; upgrade-insecure-requests;"
        );
        const html = await renderSpaIndexHtml(userDistPath, nonce);
        res.send(html);
      } catch (err) {
        console.error('[Frontend] Failed to render user index.html:', err.message);
        res.status(500).send('Internal server error');
      }
    });

    const adminServers = listenOnHosts(adminApp, serverConfig.ports.admin, apiHosts, 'Admin frontend');
    const userServers = listenOnHosts(userApp, serverConfig.ports.user, apiHosts, 'User frontend');
    allServers.push(...adminServers, ...userServers);
  } else {
    const devLines = localIPs.map(ip => `        API:     http://${ip}:${apiPort}`).join('\n');
    console.log(`  [dev] Access URLs:`);
    console.log(devLines);
    console.log(`        Admin: http://localhost:${adminPort}`);
    console.log(`        User:  http://localhost:${userPort}`);
  }
};

startServer().catch(console.error);

