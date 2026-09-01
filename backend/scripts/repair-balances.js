/**
 * Balance repair script.
 *
 * Recomputes users.balance and workspaces.balance from authoritative sources:
 *   - payment_orders (paid) for recharges
 *   - billing_records (recharge/refund/consume)
 *   - request_logs + user_keys for API call consumption
 *
 * This fixes historical cross-contamination between workspace and personal
 * account balances caused by older code that updated both balances at once.
 *
 * Usage:
 *   node scripts/repair-balances.js           # dry-run (default)
 *   node scripts/repair-balances.js --apply   # actually update DB
 */

require('dotenv').config();
const db = require('../src/config/database');

const APPLY = process.argv.includes('--apply');

function resolveOrderTarget(order) {
  let metaTarget = null;
  try {
    const parsed = JSON.parse(order.metadata || '{}');
    metaTarget = parsed.target;
  } catch { /* ignore */ }
  const defaultTarget = order.workspace_id ? 'workspace' : 'account';
  return ['workspace', 'account'].includes(metaTarget) ? metaTarget : defaultTarget;
}

function resolveBillingTarget(record) {
  // New records store target in metadata
  let metaTarget = null;
  try {
    const parsed = JSON.parse(record.metadata || '{}');
    metaTarget = parsed.target;
  } catch { /* ignore */ }
  if (['workspace', 'account'].includes(metaTarget)) return metaTarget;

  // Legacy fallback: if workspace_id is set we assume workspace; otherwise account.
  // This matches the corrected semantics (workspace and account are independent).
  return record.workspace_id ? 'workspace' : 'account';
}

async function main() {
  console.log(`[repair-balances] Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // 1. Snapshot current balances
  const usersBefore = await db.all('SELECT id, username, balance FROM users ORDER BY id');
  const workspacesBefore = await db.all('SELECT id, name, balance FROM workspaces ORDER BY id');

  console.log('\nCurrent user balances:');
  for (const u of usersBefore) console.log(`  user ${u.id} (${u.username}): ${u.balance}`);
  console.log('\nCurrent workspace balances:');
  for (const w of workspacesBefore) console.log(`  workspace ${w.id} (${w.name}): ${w.balance}`);

  // 2. Build recomputed balances
  const userBalances = {};
  const workspaceBalances = {};

  function addUser(userId, amount) {
    if (!userId) return;
    userBalances[userId] = (userBalances[userId] || 0) + amount;
  }
  function addWorkspace(wsId, amount) {
    if (!wsId) return;
    workspaceBalances[wsId] = (workspaceBalances[wsId] || 0) + amount;
  }

  // 2.1 Payment orders (paid) -> recharges
  const paidOrders = await db.all("SELECT * FROM payment_orders WHERE status = 'paid' ORDER BY id");
  console.log(`\nProcessing ${paidOrders.length} paid payment_orders...`);
  for (const order of paidOrders) {
    const target = resolveOrderTarget(order);
    const amount = Number(order.original_amount || order.amount);
    if (target === 'workspace' && order.workspace_id) {
      addWorkspace(order.workspace_id, amount);
    } else if (target === 'account') {
      addUser(order.user_id, amount);
    }
  }

  // 2.2 Billing records -> recharge/refund/consume
  const billingRecords = await db.all("SELECT * FROM billing_records ORDER BY id");
  console.log(`Processing ${billingRecords.length} billing_records...`);
  for (const record of billingRecords) {
    const amount = Number(record.amount);
    const target = resolveBillingTarget(record);
    switch (record.type) {
      case 'recharge':
        if (target === 'workspace' && record.workspace_id) addWorkspace(record.workspace_id, amount);
        else if (target === 'account') addUser(record.user_id, amount);
        break;
      case 'refund':
        if (target === 'workspace' && record.workspace_id) addWorkspace(record.workspace_id, -amount);
        else if (target === 'account') addUser(record.user_id, -amount);
        break;
      case 'consume':
        if (target === 'workspace' && record.workspace_id) addWorkspace(record.workspace_id, -amount);
        else if (target === 'account') addUser(record.user_id, -amount);
        break;
      default:
        // ignore unknown types
        break;
    }
  }

  // 2.3 API call consumption from request_logs
  // request_logs does not have workspace_id; link through user_keys.
  const logs = await db.all(`
    SELECT r.user_id, r.user_key_id, r.cost_local, k.workspace_id
    FROM request_logs r
    LEFT JOIN user_keys k ON k.id = r.user_key_id
    WHERE r.cost_local IS NOT NULL AND r.cost_local > 0
    ORDER BY r.id
  `);
  console.log(`Processing ${logs.length} request_logs with cost...`);
  for (const log of logs) {
    const cost = Number(log.cost_local);
    if (log.workspace_id) {
      addWorkspace(log.workspace_id, -cost);
    } else if (log.user_id) {
      addUser(log.user_id, -cost);
    }
  }

  // 3. Compare and optionally apply
  console.log('\nRecomputed user balances:');
  for (const u of usersBefore) {
    const recomputed = Number(userBalances[u.id] || 0).toFixed(4);
    const marker = Number(u.balance).toFixed(4) !== recomputed ? '*' : ' ';
    console.log(`  ${marker} user ${u.id} (${u.username}): ${u.balance} -> ${recomputed}`);
  }

  console.log('\nRecomputed workspace balances:');
  for (const w of workspacesBefore) {
    const recomputed = Number(workspaceBalances[w.id] || 0).toFixed(4);
    const marker = Number(w.balance).toFixed(4) !== recomputed ? '*' : ' ';
    console.log(`  ${marker} workspace ${w.id} (${w.name}): ${w.balance} -> ${recomputed}`);
  }

  if (!APPLY) {
    console.log('\n[repair-balances] Dry-run complete. Use --apply to write changes.');
    process.exit(0);
  }

  // 4. Apply updates
  console.log('\n[repair-balances] Applying updates...');
  for (const u of usersBefore) {
    const newBalance = Number(userBalances[u.id] || 0);
    await db.run('UPDATE users SET balance = ? WHERE id = ?', [newBalance, u.id]);
  }
  for (const w of workspacesBefore) {
    const newBalance = Number(workspaceBalances[w.id] || 0);
    await db.run('UPDATE workspaces SET balance = ? WHERE id = ?', [newBalance, w.id]);
  }

  console.log('[repair-balances] Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('[repair-balances] Failed:', err);
  process.exit(1);
});
