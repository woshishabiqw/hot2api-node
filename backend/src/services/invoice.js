const db = require('../config/database');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { EventEmitter } = require('events');

// Must stay in sync with routes/billing.js ORDER_TIMEOUT_MINUTES
const INVOICE_TIMEOUT_MINUTES = 30;
const INVOICE_FILE_VALIDITY_DAYS = 30;
const INVOICE_REISSUE_COOLDOWN_HOURS = 24;

const invoiceEmitter = new EventEmitter();
const INVOICES_DIR = path.join(__dirname, '..', '..', 'invoices');

function ensureInvoicesDir() {
  if (!fs.existsSync(INVOICES_DIR)) {
    fs.mkdirSync(INVOICES_DIR, { recursive: true });
  }
}

async function ensureTable() {
  try {
    await db.run(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        order_id INTEGER,
        workspace_id INTEGER,
        user_id INTEGER,
        amount NUMERIC(12,2) NOT NULL DEFAULT 0,
        status VARCHAR(32) DEFAULT 'pending',
        review_status VARCHAR(32) DEFAULT 'pending',
        invoice_no VARCHAR(64),
        title VARCHAR(255),
        email VARCHAR(255),
        tax_number VARCHAR(50),
        invoice_url TEXT,
        invoice_file_path TEXT,
        invoice_file_created_at TIMESTAMP,
        rejected_reason TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        issued_at TIMESTAMP,
        reviewed_at TIMESTAMP,
        failed_at TIMESTAMP
      )
    `);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_order_id ON invoices(order_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_user_id ON invoices(user_id)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)`);
    await db.run(`CREATE INDEX IF NOT EXISTS idx_invoices_review_status ON invoices(review_status)`);

    const migrationSqls = [
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS review_status VARCHAR(32) DEFAULT 'pending'`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_url TEXT`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_file_path TEXT`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_file_created_at TIMESTAMP`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS rejected_reason TEXT`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS tax_number VARCHAR(50)`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
      `ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP`,
    ];
    for (const sql of migrationSqls) {
      try { await db.run(sql); } catch (e) { /* ignore if column exists */ }
    }
    ensureInvoicesDir();
  } catch (e) {
    console.error('[Invoice] ensureTable failed:', e.message);
  }
}

async function getInvoiceReviewMode() {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'invoice_review_mode'");
    return row?.value === 'manual' ? 'manual' : 'auto';
  } catch (e) {
    return 'auto';
  }
}

async function setInvoiceReviewMode(mode) {
  const value = mode === 'manual' ? 'manual' : 'auto';
  const existing = await db.get("SELECT value FROM settings WHERE key = 'invoice_review_mode'");
  if (existing) {
    await db.run("UPDATE settings SET value = ? WHERE key = 'invoice_review_mode'", [value]);
  } else {
    await db.run("INSERT INTO settings (key, value) VALUES ('invoice_review_mode', ?)", [value]);
  }
  return value;
}

function generateInvoiceNo() {
  return `INV${Date.now()}${crypto.randomInt(1000, 9999)}`;
}

function generateInvoiceUrl(invoiceId) {
  return `/billing/invoices/${invoiceId}/download`;
}

function getFileExpiry(invoice) {
  if (!invoice.invoice_file_created_at) return null;
  const created = new Date(invoice.invoice_file_created_at);
  return new Date(created.getTime() + INVOICE_FILE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}

function isFileExpired(invoice) {
  const expiry = getFileExpiry(invoice);
  if (!expiry) return false;
  return expiry <= new Date();
}

async function buildInvoiceXlsxBuffer(invoice) {
  const order = await db.get('SELECT trade_no, channel FROM payment_orders WHERE id = ?', [invoice.order_id]);
  const user = await db.get('SELECT username FROM users WHERE id = ?', [invoice.user_id]);
  const workspace = await db.get('SELECT name FROM workspaces WHERE id = ?', [invoice.workspace_id]);
  const amount = Number(invoice.amount).toFixed(2);
  const issuedAt = invoice.issued_at ? new Date(invoice.issued_at).toLocaleString('zh-CN') : '-';
  const expiresAt = getFileExpiry(invoice)?.toLocaleString('zh-CN') || '-';

  const rows = [
    ['电子发票'],
    [],
    ['发票号码', invoice.invoice_no || '-'],
    ['开票时间', issuedAt],
    ['订单号', order?.trade_no || '-'],
    ['Workspace', workspace?.name || '-'],
    ['用户', user?.username || '-'],
    ['发票抬头', invoice.title || '-'],
    ['税号', invoice.tax_number || '-'],
    ['邮箱', invoice.email || '-'],
    ['支付渠道', order?.channel || '-'],
    ['文件有效期至', expiresAt],
    [],
    ['合计金额', `¥${amount}`],
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 20 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, '发票');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function saveInvoiceXlsx(invoice) {
  ensureInvoicesDir();
  const invoiceNo = invoice.invoice_no || generateInvoiceNo();
  const fileName = `${invoiceNo}.xlsx`;
  const filePath = path.join(INVOICES_DIR, fileName);
  const buffer = await buildInvoiceXlsxBuffer({ ...invoice, invoice_no: invoiceNo });
  fs.writeFileSync(filePath, buffer);
  return { filePath, invoiceNo };
}

async function regenerateInvoiceFile(invoice) {
  const { filePath, invoiceNo } = await saveInvoiceXlsx(invoice);
  const invoiceUrl = generateInvoiceUrl(invoice.id);
  await db.run(
    `UPDATE invoices SET invoice_no = ?, invoice_url = ?, invoice_file_path = ?, invoice_file_created_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [invoiceNo, invoiceUrl, filePath, invoice.id]
  );
  return db.get('SELECT * FROM invoices WHERE id = ?', [invoice.id]);
}

async function getInvoiceByOrderId(orderId) {
  await ensureTable();
  return db.get('SELECT * FROM invoices WHERE order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
}

async function createInvoice(order, opts = {}) {
  await ensureTable();
  if (!order) return null;

  const result = await db.run(
    `INSERT INTO invoices (order_id, workspace_id, user_id, amount, status, review_status, title, email, tax_number)
     VALUES (?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)`,
    [
      order.id,
      order.workspace_id,
      order.user_id,
      order.amount,
      opts.title || `Workspace 充值`,
      opts.email || null,
      opts.tax_number || null,
    ]
  );
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [result.lastInsertRowid]);
  invoiceEmitter.emit('invoice:created', invoice);
  return invoice;
}

async function markIssued(invoiceId, opts = {}) {
  await ensureTable();
  let invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) throw new Error('发票不存在');

  const invoiceNo = opts.invoiceNo || invoice.invoice_no || generateInvoiceNo();
  const { filePath } = await saveInvoiceXlsx({ ...invoice, invoice_no: invoiceNo });
  const invoiceUrl = generateInvoiceUrl(invoiceId);

  await db.run(
    `UPDATE invoices SET status = 'issued', review_status = 'approved', invoice_no = ?, invoice_url = ?, invoice_file_path = ?, invoice_file_created_at = datetime('now'), issued_at = datetime('now'), reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [invoiceNo, invoiceUrl, filePath, invoiceId]
  );
  invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  invoiceEmitter.emit('invoice:updated', invoice);
  return invoice;
}

async function markRemoved(invoiceId) {
  await ensureTable();
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) return null;
  if (invoice.invoice_file_path && fs.existsSync(invoice.invoice_file_path)) {
    try { fs.unlinkSync(invoice.invoice_file_path); } catch (e) { console.error('[Invoice] Failed to remove file:', e.message); }
  }
  await db.run(
    `UPDATE invoices SET status = 'removed', invoice_url = NULL, invoice_file_path = NULL, invoice_file_created_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    [invoiceId]
  );
  const updated = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  invoiceEmitter.emit('invoice:updated', updated);
  return updated;
}

async function markFailed(invoiceId, error) {
  await ensureTable();
  await db.run(
    `UPDATE invoices SET status = 'failed', error_message = ?, failed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [error?.message || String(error), invoiceId]
  );
  const updated = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  invoiceEmitter.emit('invoice:updated', updated);
  return updated;
}

async function scheduleAutoApprove(invoiceId) {
  const delay = 3000 + Math.floor(Math.random() * 2000); // 3-5s
  setTimeout(async () => {
    try {
      const mode = await getInvoiceReviewMode();
      if (mode !== 'auto') return;
      const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
      if (invoice && invoice.status === 'pending' && invoice.review_status === 'pending') {
        await markIssued(invoiceId);
      }
    } catch (e) {
      console.error('[Invoice] Auto approve failed:', e.message);
    }
  }, delay);
}

async function issueInvoiceForOrder(order, opts = {}) {
  await ensureTable();
  if (!order || order.status !== 'paid') {
    throw new Error('只有已支付订单才能开票');
  }

  const latest = await getInvoiceByOrderId(order.id);
  if (latest) {
    const created = new Date(latest.created_at);
    const cooldownDeadline = new Date(created.getTime() + INVOICE_REISSUE_COOLDOWN_HOURS * 60 * 60 * 1000);
    if (cooldownDeadline > new Date()) {
      throw new Error('该订单已提交开票申请，24 小时内不可重复开票');
    }
  }

  try {
    const invoice = await createInvoice(order, opts);
    const mode = await getInvoiceReviewMode();
    if (mode === 'auto') {
      scheduleAutoApprove(invoice.id);
    }
    return invoice;
  } catch (err) {
    const invoice = await getInvoiceByOrderId(order.id);
    if (invoice) await markFailed(invoice.id, err);
    throw err;
  }
}

async function reviewInvoice(invoiceId, action, reason = '') {
  await ensureTable();
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) throw new Error('发票不存在');
  if (invoice.status === 'issued') throw new Error('发票已开具，无需审核');
  if (invoice.status === 'removed') throw new Error('发票文件已过期');

  if (action === 'approve') {
    return markIssued(invoice.id);
  } else if (action === 'reject') {
    await db.run(
      `UPDATE invoices SET status = 'rejected', review_status = 'rejected', rejected_reason = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
      [reason || '审核未通过', invoiceId]
    );
    const updated = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
    invoiceEmitter.emit('invoice:updated', updated);
    return updated;
  }
  throw new Error('无效的审核操作');
}

async function retryInvoice(invoiceId) {
  await ensureTable();
  const invoice = await db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
  if (!invoice) throw new Error('发票不存在');
  try {
    return await markIssued(invoice.id);
  } catch (err) {
    await markFailed(invoice.id, err);
    throw err;
  }
}

async function listInvoices({ userId, orderId, status, reviewStatus, page = 1, limit = 50 }) {
  await ensureTable();
  const where = [];
  const params = [];
  if (userId) { where.push('i.user_id = ?'); params.push(userId); }
  if (orderId) { where.push('i.order_id = ?'); params.push(orderId); }
  if (status) { where.push('i.status = ?'); params.push(status); }
  if (reviewStatus) { where.push('i.review_status = ?'); params.push(reviewStatus); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;

  const invoices = await db.all(
    `SELECT i.*, o.trade_no, o.amount as order_amount, o.channel as order_channel, w.name as workspace_name, u.username as user_name
     FROM invoices i
     LEFT JOIN payment_orders o ON o.id = i.order_id
     LEFT JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN users u ON u.id = i.user_id
     ${whereSql}
     ORDER BY i.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );
  const countRow = await db.get(`SELECT COUNT(*) as count FROM invoices i ${whereSql}`, params);
  return {
    invoices: invoices.map(inv => ({ ...inv, file_expires_at: getFileExpiry(inv)?.toISOString() || null })),
    total: countRow?.count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((countRow?.count || 0) / l)
  };
}

async function expireOldPendingOrders() {
  await ensureTable();
  // Use explicit expires_at when available: it defines the order lifetime.
  // Legacy rows without expires_at expire INVOICE_TIMEOUT_MINUTES after creation.
  const oldOrders = await db.all(
    `SELECT * FROM payment_orders WHERE status = 'pending'
     AND (
       (expires_at IS NOT NULL AND expires_at < NOW())
       OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '${INVOICE_TIMEOUT_MINUTES} minutes')
     )`
  );
  for (const order of oldOrders) {
    if (order.coupon_id) {
      const userCoupon = await db.get('SELECT * FROM user_coupons WHERE id = ?', [order.coupon_id]);
      if (userCoupon) {
        await db.run(
          `UPDATE user_coupons SET status = 'unused', order_id = NULL, used_at = NULL WHERE id = ?`,
          [order.coupon_id]
        );
        await db.run(
          `UPDATE coupons SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END WHERE id = ?`,
          [userCoupon.coupon_id]
        );
      }
    }
  }
  const result = await db.run(
    `UPDATE payment_orders SET status = 'expired' WHERE status = 'pending'
     AND (
       (expires_at IS NOT NULL AND expires_at < NOW())
       OR (expires_at IS NULL AND created_at < NOW() - INTERVAL '${INVOICE_TIMEOUT_MINUTES} minutes')
     )`
  );
  if (result.changes > 0) {
    console.log(`[Billing] Expired ${result.changes} pending orders older than ${INVOICE_TIMEOUT_MINUTES} minutes`);
  }
  return result.changes;
}

async function getInvoiceAuditLog({ page = 1, limit = 50 } = {}) {
  await ensureTable();
  const actions = [
    'invoice_auto_issued',
    'admin_invoice_reviewed',
    'invoice_settings_changed',
    'invoice_issued',
    'invoice_failed',
    'invoice_retry',
    'invoice_file_expired'
  ];
  const placeholders = actions.map(() => '?').join(',');
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const offset = (p - 1) * l;
  const logs = await db.all(
    `SELECT * FROM billing_logs WHERE action IN (${placeholders}) ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...actions, l, offset]
  );
  const countRow = await db.get(
    `SELECT COUNT(*) as count FROM billing_logs WHERE action IN (${placeholders})`,
    actions
  );
  return {
    logs: logs.map(row => ({
      ...row,
      data: (() => { try { return JSON.parse(row.data); } catch { return row.data; } })()
    })),
    total: countRow?.count || 0,
    page: p,
    limit: l,
    totalPages: Math.ceil((countRow?.count || 0) / l)
  };
}

function startAutoReviewProcessor(intervalMs = 5000) {
  setInterval(async () => {
    try {
      const mode = await getInvoiceReviewMode();
      if (mode !== 'auto') return;
      const pending = await db.all(
        `SELECT * FROM invoices WHERE status = 'pending' AND review_status = 'pending' AND created_at < datetime('now', '-5 seconds')`
      );
      for (const inv of pending) {
        await markIssued(inv.id);
      }
      if (pending.length > 0) {
        console.log(`[Invoice] Auto-approved ${pending.length} invoice(s)`);
      }
    } catch (e) {
      console.error('[Invoice] Auto-review processor error:', e.message);
    }
  }, intervalMs);
}

async function cleanupExpiredInvoiceFiles() {
  await ensureTable();
  try {
    const expired = await db.all(
      `SELECT * FROM invoices WHERE status = 'issued' AND invoice_file_created_at < NOW() - INTERVAL '${INVOICE_FILE_VALIDITY_DAYS} days'`
    );
    for (const inv of expired) {
      await markRemoved(inv.id);
      await logBilling('invoice_file_expired', { invoice_id: inv.id, invoice_no: inv.invoice_no });
    }
    if (expired.length > 0) {
      console.log(`[Invoice] Cleaned up ${expired.length} expired invoice file(s)`);
    }
  } catch (e) {
    console.error('[Invoice] Cleanup error:', e.message);
  }
}

function startInvoiceFileCleanup(intervalMs = 60 * 60 * 1000) {
  cleanupExpiredInvoiceFiles().catch(console.error);
  setInterval(() => {
    cleanupExpiredInvoiceFiles().catch(console.error);
  }, intervalMs);
}

async function logBilling(action, data) {
  try {
    await db.run(
      `INSERT INTO billing_logs (action, data, created_at) VALUES (?, ?, datetime('now'))`,
      [action, JSON.stringify(data)]
    );
  } catch (e) {
    console.error('[Billing] log failed:', e.message);
  }
}

module.exports = {
  ensureTable,
  createInvoice,
  getInvoiceByOrderId,
  issueInvoiceForOrder,
  reviewInvoice,
  retryInvoice,
  markIssued,
  listInvoices,
  expireOldPendingOrders,
  getInvoiceReviewMode,
  setInvoiceReviewMode,
  getInvoiceAuditLog,
  startAutoReviewProcessor,
  startInvoiceFileCleanup,
  invoiceEmitter,
  getFileExpiry,
  isFileExpired,
  markRemoved,
  regenerateInvoiceFile,
  INVOICE_TIMEOUT_MINUTES,
  INVOICE_FILE_VALIDITY_DAYS,
};
