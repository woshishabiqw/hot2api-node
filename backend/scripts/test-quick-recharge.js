/**
 * Deep test for admin quick-recharge target=account / target=workspace.
 * Creates a test admin, workspace, runs two quick-recharges and asserts balances.
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../src/config/database');

const BASE_URL = 'http://localhost:3000';
const api = axios.create({ baseURL: BASE_URL, timeout: 15000 });

function loadEnv(filePath) {
  const env = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      let key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch (e) {
    console.error('Failed to load .env:', e.message);
  }
  return env;
}

loadEnv(path.join(__dirname, '..', '.env'));

const TEST_USERNAME = `testadmin_${Date.now()}`;
const TEST_PASSWORD = 'TestPass123!';

function log(msg) {
  console.log(`[TEST] ${msg}`);
}

async function assertEqual(actual, expected, label) {
  if (Math.abs(actual - expected) > 0.001) {
    throw new Error(`${label} 断言失败: 期望 ${expected}, 实际 ${actual}`);
  }
  log(`✓ ${label}: ${actual}`);
}

async function run() {
  log(`创建测试用户 ${TEST_USERNAME}`);
  const registerRes = await api.post('/auth/register', { username: TEST_USERNAME, password: TEST_PASSWORD });
  const userId = registerRes.data.id;
  log(`用户 ID: ${userId}`);

  log('提升为管理员');
  await db.run('UPDATE users SET role = ? WHERE id = ?', ['admin', userId]);

  log('登录获取 token');
  const loginRes = await api.post('/auth/login', { username: TEST_USERNAME, password: TEST_PASSWORD });
  const token = loginRes.data.token;
  api.defaults.headers.Authorization = `Bearer ${token}`;
  log('登录成功，token 已设置');

  log('创建测试 Workspace');
  const wsRes = await api.post('/workspaces', { name: `Test Workspace ${Date.now()}` });
  const workspaceId = wsRes.data.id;
  log(`Workspace ID: ${workspaceId}`);

  log('查询初始余额');
  const wsListRes = await api.get('/workspaces');
  const workspace = wsListRes.data.find(w => w.id === workspaceId);
  const userBalanceRes = await api.get('/billing/user-balance');
  const initialWorkspaceBalance = workspace?.balance || 0;
  const initialUserBalance = userBalanceRes.data.balance || 0;
  log(`初始 Workspace 余额: ${initialWorkspaceBalance}, 账户余额: ${initialUserBalance}`);

  const accountAmount = 10.55;
  log(`执行 target=account 快速充值 ¥${accountAmount}`);
  const accountRechargeRes = await api.post('/billing/admin/quick-recharge', {
    workspace_id: workspaceId,
    amount: accountAmount,
    target: 'account',
  });
  log(`响应: ${JSON.stringify(accountRechargeRes.data)}`);

  log('校验 account 充值后余额');
  const wsListAfterAccount = await api.get('/workspaces');
  const workspaceAfterAccount = wsListAfterAccount.data.find(w => w.id === workspaceId);
  const userBalanceAfterAccount = (await api.get('/billing/user-balance')).data.balance;
  await assertEqual(workspaceAfterAccount.balance, initialWorkspaceBalance, 'account 充值后 Workspace 余额应不变');
  await assertEqual(userBalanceAfterAccount, initialUserBalance + accountAmount, 'account 充值后账户余额应增加');

  const workspaceAmount = 5.33;
  log(`执行 target=workspace 快速充值 ¥${workspaceAmount}`);
  const workspaceRechargeRes = await api.post('/billing/admin/quick-recharge', {
    workspace_id: workspaceId,
    amount: workspaceAmount,
    target: 'workspace',
  });
  log(`响应: ${JSON.stringify(workspaceRechargeRes.data)}`);

  log('校验 workspace 充值后余额');
  const wsListAfterWorkspace = await api.get('/workspaces');
  const workspaceAfterWorkspace = wsListAfterWorkspace.data.find(w => w.id === workspaceId);
  const userBalanceAfterWorkspace = (await api.get('/billing/user-balance')).data.balance;
  await assertEqual(workspaceAfterWorkspace.balance, initialWorkspaceBalance + workspaceAmount, 'workspace 充值后 Workspace 余额应增加');
  await assertEqual(userBalanceAfterWorkspace, initialUserBalance + accountAmount, 'workspace 充值后账户余额应不变');

  log('校验 billing_records 中余额记录正确');
  const recordsRes = await api.get(`/workspaces/${workspaceId}/billing?limit=10`);
  const records = recordsRes.data.records || [];
  const accountRecord = records.find(r => r.amount === accountAmount);
  const workspaceRecord = records.find(r => r.amount === workspaceAmount);
  if (!accountRecord) throw new Error('未找到 account 充值账单记录');
  if (!workspaceRecord) throw new Error('未找到 workspace 充值账单记录');
  await assertEqual(accountRecord.user_balance_after, initialUserBalance + accountAmount, 'account 记录 user_balance_after');
  await assertEqual(accountRecord.balance_after, initialWorkspaceBalance, 'account 记录 balance_after 应等于初始 Workspace 余额');
  await assertEqual(workspaceRecord.user_balance_after, initialUserBalance + accountAmount, 'workspace 记录 user_balance_after 应等于 account 充值后余额');
  await assertEqual(workspaceRecord.balance_after, initialWorkspaceBalance + workspaceAmount, 'workspace 记录 balance_after');

  log('测试用户钱包充值 target=account（通过 mock 支付）');
  const userAccountAmount = 3;
  const userAccountRecharge = await api.post('/billing/recharge', {
    workspace_id: workspaceId,
    amount: userAccountAmount,
    channel: 'mock',
    target: 'account',
  });
  const accountPaymentUrl = new URL(userAccountRecharge.data.payment_url, BASE_URL);
  await api.get(`/billing/pay-mock?order_id=${accountPaymentUrl.searchParams.get('order_id')}&trade_no=${accountPaymentUrl.searchParams.get('trade_no')}`);
  const userBalanceAfterUserAccount = (await api.get('/billing/user-balance')).data.balance;
  const wsAfterUserAccount = (await api.get('/workspaces')).data.find(w => w.id === workspaceId);
  await assertEqual(userBalanceAfterUserAccount, initialUserBalance + accountAmount + userAccountAmount, '用户钱包 account 充值后账户余额');
  await assertEqual(wsAfterUserAccount.balance, initialWorkspaceBalance + workspaceAmount, '用户钱包 account 充值后 Workspace 余额应不变');

  log('测试用户钱包充值 target=workspace（通过 mock 支付）');
  const userWorkspaceAmount = 2;
  const userWorkspaceRecharge = await api.post('/billing/recharge', {
    workspace_id: workspaceId,
    amount: userWorkspaceAmount,
    channel: 'mock',
    target: 'workspace',
  });
  const workspacePaymentUrl = new URL(userWorkspaceRecharge.data.payment_url, BASE_URL);
  await api.get(`/billing/pay-mock?order_id=${workspacePaymentUrl.searchParams.get('order_id')}&trade_no=${workspacePaymentUrl.searchParams.get('trade_no')}`);
  const userBalanceAfterUserWorkspace = (await api.get('/billing/user-balance')).data.balance;
  const wsAfterUserWorkspace = (await api.get('/workspaces')).data.find(w => w.id === workspaceId);
  await assertEqual(userBalanceAfterUserWorkspace, initialUserBalance + accountAmount + userAccountAmount, '用户钱包 workspace 充值后账户余额应不变');
  await assertEqual(wsAfterUserWorkspace.balance, initialWorkspaceBalance + workspaceAmount + userWorkspaceAmount, '用户钱包 workspace 充值后 Workspace 余额');

  log('全部断言通过，开始清理测试数据');
  await db.run('DELETE FROM billing_records WHERE workspace_id = ? OR user_id = ?', [workspaceId, userId]);
  await db.run('DELETE FROM payment_orders WHERE workspace_id = ? OR user_id = ?', [workspaceId, userId]);
  await db.run('DELETE FROM workspace_members WHERE workspace_id = ?', [workspaceId]);
  await db.run('DELETE FROM workspaces WHERE id = ?', [workspaceId]);
  await db.run('DELETE FROM users WHERE id = ?', [userId]);
  log('清理完成');

  console.log('\n🎉 深度测试全部通过');
}

run().catch(async (err) => {
  console.error('\n❌ 测试失败:', err.message);
  console.error(err.stack);
  // Best-effort cleanup
  try {
    const user = await db.get('SELECT id FROM users WHERE username = ?', [TEST_USERNAME]);
    if (user) {
      const workspaces = await db.all('SELECT workspace_id FROM workspace_members WHERE user_id = ?', [user.id]);
      for (const w of workspaces) {
        await db.run('DELETE FROM billing_records WHERE workspace_id = ?', [w.workspace_id]);
        await db.run('DELETE FROM payment_orders WHERE workspace_id = ?', [w.workspace_id]);
        await db.run('DELETE FROM workspace_members WHERE workspace_id = ?', [w.workspace_id]);
        await db.run('DELETE FROM workspaces WHERE id = ?', [w.workspace_id]);
      }
      await db.run('DELETE FROM users WHERE id = ?', [user.id]);
    }
  } catch (cleanupErr) {
    console.error('清理失败:', cleanupErr.message);
  }
  process.exit(1);
});
