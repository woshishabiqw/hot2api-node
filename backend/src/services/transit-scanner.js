const { Worker } = require('worker_threads');
const path = require('path');
const os = require('os');
const { AsyncLocalStorage } = require('async_hooks');
const db = require('../config/database');

const DISABLED = process.env.DISABLE_TRANSIT_SCAN === '1';
const MAX_SCAN_BYTES = parseInt(process.env.TRANSIT_SCAN_MAX_BYTES, 10) || 131072; // 128KB
const WORKER_COUNT = Math.max(2, Math.min(os.cpus().length, 8));
const MAX_QUEUE_SIZE = parseInt(process.env.TRANSIT_SCAN_MAX_QUEUE, 10) || 1000;
const requestContext = new AsyncLocalStorage();

let enabledCache = { value: true, ts: 0 };
const ENABLED_CACHE_TTL_MS = 5000;

class TransitScanner {
  constructor() {
    // Lazy ensure table: don't hit the DB during app startup, when the pool
    // may already be under pressure from other init queries and connection
    // limits. This avoids blocking the event loop for seconds on boot.
    this.ensureTablePromise = null;
    this.workers = [];
    this.freeWorkers = [];
    this.queue = [];
    this.pending = new Map(); // taskId -> { resolve, reject }
    this.taskId = 0;
    if (!DISABLED) {
      this.initWorkers();
    }
  }

  _lazyEnsureTable() {
    if (!this.ensureTablePromise) {
      this.ensureTablePromise = this.ensureTable();
    }
    return this.ensureTablePromise;
  }

  async ensureTable() {
    try {
      await db.run(`
        CREATE TABLE IF NOT EXISTS transit_scans (
          id SERIAL PRIMARY KEY,
          request_log_id INTEGER,
          request_uuid VARCHAR(64),
          user_id INTEGER,
          user_key_id INTEGER,
          source_id INTEGER,
          instance_id INTEGER,
          workspace_id INTEGER,
          model VARCHAR(255),
          protocol VARCHAR(50),
          status_code INTEGER,
          result VARCHAR(20) NOT NULL,
          matched_rules TEXT,
          details TEXT,
          payload_sample TEXT,
          created_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Migrate existing tables created before the request_uuid column was added.
      try {
        const cols = await db.all("SELECT column_name FROM information_schema.columns WHERE table_name = 'transit_scans'");
        const colNames = (cols || []).map(c => c.column_name || c.COLUMN_NAME);
        if (!colNames.includes('request_uuid')) {
          await db.run("ALTER TABLE transit_scans ADD COLUMN request_uuid VARCHAR(64)");
        }
      } catch (e) {
        console.warn('[TransitScanner] Failed to ensure request_uuid column:', e.message);
      }
      await db.run(`CREATE INDEX IF NOT EXISTS idx_transit_scans_result ON transit_scans(result)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_transit_scans_created_at ON transit_scans(created_at DESC)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_transit_scans_source_id ON transit_scans(source_id)`);
      await db.run(`CREATE INDEX IF NOT EXISTS idx_transit_scans_request_uuid ON transit_scans(request_uuid)`);
    } catch (err) {
      console.error('[TransitScanner] Failed to ensure table:', err.message);
    }
  }

  initWorkers() {
    const workerPath = path.join(__dirname, 'transit-scanner.worker.js');
    for (let i = 0; i < WORKER_COUNT; i++) {
      this.spawnWorker(workerPath);
    }
  }

  spawnWorker(workerPath) {
    const worker = new Worker(workerPath);
    worker.on('message', (msg) => this.handleWorkerMessage(worker, msg));
    worker.on('error', (err) => this.handleWorkerError(worker, err));
    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[TransitScanner] Worker exited with code ${code}, respawning...`);
        this.spawnWorker(workerPath);
      }
    });
    this.workers.push(worker);
    this.freeWorkers.push(worker);
  }

  handleWorkerMessage(worker, msg) {
    const task = this.pending.get(msg.id);
    if (task) {
      this.pending.delete(msg.id);
      task.resolve(msg.result);
    }
    this.dispatch(worker);
  }

  handleWorkerError(worker, err) {
    console.error('[TransitScanner] Worker error:', err.message);
    // reject all pending tasks assigned to this worker? We don't track per-worker task.
    // Simpler: free worker and let queued tasks be handled by respawned workers.
    worker.terminate().catch(() => {});
  }

  dispatch(worker) {
    if (this.queue.length === 0) {
      if (!this.freeWorkers.includes(worker)) this.freeWorkers.push(worker);
      return;
    }
    const task = this.queue.shift();
    this.pending.set(task.id, { resolve: task.resolve, reject: task.reject });
    worker.postMessage({ id: task.id, payload: task.payload });
  }

  async runScan(payload) {
    return new Promise((resolve) => {
      if (this.queue.length >= MAX_QUEUE_SIZE) {
        resolve({ result: 'unknown', matchedRules: [], details: '扫描队列已满，标记为未知' });
        return;
      }
      const id = ++this.taskId;
      this.queue.push({ id, payload, resolve });
      if (this.freeWorkers.length > 0) {
        const worker = this.freeWorkers.pop();
        this.dispatch(worker);
      }
    });
  }

  normalizePayload(raw) {
    if (!raw) return '';
    if (Buffer.isBuffer(raw)) {
      return raw.toString('utf8', 0, Math.min(raw.length, MAX_SCAN_BYTES));
    }
    const str = String(raw);
    return str.length > MAX_SCAN_BYTES ? str.substring(0, MAX_SCAN_BYTES) : str;
  }

  async isEnabled() {
    if (DISABLED) return false;
    const now = Date.now();
    if (now - enabledCache.ts < ENABLED_CACHE_TTL_MS) return enabledCache.value;
    try {
      const row = await db.get("SELECT value FROM settings WHERE key = 'transit_scan_enabled'");
      enabledCache.value = row ? (row.value === 'true' || row.value === '1') : true;
    } catch (e) {
      enabledCache.value = true;
    }
    enabledCache.ts = now;
    return enabledCache.value;
  }

  async setEnabled(value) {
    const enabled = Boolean(value);
    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      ['transit_scan_enabled', enabled ? 'true' : 'false']
    );
    enabledCache = { value: enabled, ts: Date.now() };
    return enabled;
  }

  getRequestContext() {
    return requestContext.getStore();
  }

  async scan({ rawBody, req, source, statusCode, requestLogId, requestUuid }) {
    if (DISABLED) return;
    if (!(await this.isEnabled())) return;
    await this._lazyEnsureTable();

    const payload = this.normalizePayload(rawBody);
    if (!payload) return;

    const result = await this.runScan(payload);

    const store = requestContext.getStore();
    const userId = req?.apiKey?.userId || req?.user?.id || null;
    const userKeyId = req?.apiKey?.id || null;
    const workspaceId = req?.apiKey?.workspaceId || null;
    const sourceId = source?.id ?? null;
    const instanceId = source?._instanceId || null;
    const model = req?.body?.model || null;
    const protocol = req?._clientProtocol || req?.clientProtocol || null;
    const finalRequestUuid = requestUuid || store?.requestUuid || null;

    if (result.result === 'danger') {
      console.warn(`[TransitScanner] DANGER source=${source?.name || source?.id || '?'} model=${model} status=${statusCode} rules=${result.matchedRules.map(r => r.id).join(',')}`);
    }

    try {
      await db.run(
        `INSERT INTO transit_scans
         (request_log_id, request_uuid, user_id, user_key_id, source_id, instance_id, workspace_id, model, protocol, status_code, result, matched_rules, details, payload_sample)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requestLogId || null,
          finalRequestUuid,
          userId,
          userKeyId,
          sourceId,
          instanceId,
          workspaceId,
          model,
          protocol,
          statusCode || null,
          result.result,
          JSON.stringify(result.matchedRules || []),
          result.details || '',
          payload.substring(0, 500)
        ]
      );
    } catch (err) {
      console.error('[TransitScanner] Failed to save scan result:', err.message);
    }

    return result;
  }
}

module.exports = new TransitScanner();
module.exports.requestContext = requestContext;
