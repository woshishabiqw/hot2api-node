const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authMiddleware } = require('../middleware/auth');
const audit = require('../services/audit');
const apiKeyMiddleware = require('../middleware/apikey');
const { normalizeBalance } = require('../utils/balance');

async function getUserDefaults() {
  const row = await db.get('SELECT * FROM user_defaults ORDER BY id LIMIT 1');
  return row || { tpm: 10000000, rpm: 100, tpd: 10000000, max_concurrent: 100 };
}

router.use(authMiddleware);

// Get current user's workspaces
router.get('/', async (req, res) => {
  const workspaces = await db.all(`
    SELECT w.*, m.role as member_role
    FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = ? AND w.status = 'active'
    ORDER BY w.created_at DESC
  `, [req.user.id]);
  res.json(workspaces);
});

// Get pending invites for current user (must be BEFORE /:id)
router.get('/invites', async (req, res) => {
  const invites = await db.all(`
    SELECT i.*, w.name as workspace_name, w.slug as workspace_slug, u.username as inviter_name
    FROM workspace_invites i
    JOIN workspaces w ON w.id = i.workspace_id
    JOIN users u ON u.id = i.inviter_id
    WHERE i.invitee_id = ? AND i.status = 'pending' AND w.status = 'active'
    ORDER BY i.created_at DESC, i.id DESC
  `, [req.user.id]);
  res.json(invites);
});

// Accept an invite
router.post('/invites/:id/accept', async (req, res) => {
  const inviteId = parseInt(req.params.id);

  const invite = await db.get(
    `SELECT * FROM workspace_invites WHERE id = ? AND invitee_id = ? AND status = 'pending'`,
    [inviteId, req.user.id]
  );
  if (!invite) {
    return res.status(404).json({ error: '邀请不存在或已处理' });
  }

  const existing = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [invite.workspace_id, req.user.id]
  );
  if (existing) {
    await db.run(`UPDATE workspace_invites SET status = 'accepted' WHERE id = ?`, [inviteId]);
    return res.status(400).json({ error: '你已经是该工作空间成员' });
  }

  await db.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`,
    [invite.workspace_id, req.user.id, invite.role]
  );
  await db.run(`UPDATE workspace_invites SET status = 'accepted' WHERE id = ?`, [inviteId]);

  res.json({ success: true, workspace_id: invite.workspace_id });
});

// Decline an invite
router.post('/invites/:id/decline', async (req, res) => {
  const inviteId = parseInt(req.params.id);

  const invite = await db.get(
    `SELECT * FROM workspace_invites WHERE id = ? AND invitee_id = ? AND status = 'pending'`,
    [inviteId, req.user.id]
  );
  if (!invite) {
    return res.status(404).json({ error: '邀请不存在或已处理' });
  }

  await db.run(`UPDATE workspace_invites SET status = 'declined' WHERE id = ?`, [inviteId]);
  res.json({ success: true });
});

// Get single workspace (must be member)
router.get('/:id', async (req, res) => {
  const workspace = await db.get(`
    SELECT w.*, m.role as member_role
    FROM workspaces w
    JOIN workspace_members m ON m.workspace_id = w.id
    WHERE w.id = ? AND m.user_id = ?
  `, [parseInt(req.params.id), req.user.id]);

  if (!workspace) {
    return res.status(404).json({ error: '工作空间不存在' });
  }

  // Get members
  const members = await db.all(`
    SELECT wm.*, u.username, u.role as user_role
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
  `, [workspace.id]);

  res.json({ ...workspace, members });
});

// Create workspace
router.post('/', async (req, res) => {
  const { name, owner_id, owner_username } = req.body;
  if (!name || name.length < 2 || name.length > 50) {
    return res.status(400).json({ error: '名称必须在2-50个字符之间' });
  }

  let ownerId = req.user.id;
  let ownerUsername = req.user.username;

  if (req.user.role === 'admin' && (owner_id || owner_username)) {
    let targetUser = null;
    if (owner_id) {
      targetUser = await db.get('SELECT id, username FROM users WHERE id = ?', [parseInt(owner_id)]);
    }
    if (!targetUser && owner_username) {
      targetUser = await db.get('SELECT id, username FROM users WHERE username = ?', [owner_username]);
    }
    if (!targetUser) {
      return res.status(400).json({ error: '指定的归属者不存在' });
    }
    ownerId = targetUser.id;
    ownerUsername = targetUser.username;
  }

  const slug = `${ownerUsername}-${Date.now()}`;
  const result = await db.run(
    `INSERT INTO workspaces (name, slug, owner_id, status) VALUES (?, ?, ?, 'active')`,
    [name, slug, ownerId]
  );

  await db.run(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'owner')`,
    [result.lastInsertRowid, ownerId]
  );

  audit.log({
    userId: req.user.id,
    username: req.user.username,
    action: 'create',
    resourceType: 'system',
    resourceId: result.lastInsertRowid,
    resourceName: name,
    newValue: { name, slug, owner_id: ownerId, owner_username: ownerUsername },
    req
  });

  res.status(201).json({ id: result.lastInsertRowid, name, slug, owner_id: ownerId });
});

// Update workspace (owner only)
router.put('/:id', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { name, plan_id, token_quota_limit } = req.body;

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ error: '需要所有者权限' });
  }

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (plan_id !== undefined) { fields.push('plan_id = ?'); params.push(plan_id); }
  if (token_quota_limit !== undefined) {
    const tql = parseFloat(token_quota_limit);
    if (!isFinite(tql) || tql < 0 || tql > 999999999999) {
      return res.status(400).json({ error: 'token_quota_limit 超出有效范围' });
    }
    fields.push('token_quota_limit = ?'); params.push(tql);
  }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });

  params.push(workspaceId);
  await db.run(`UPDATE workspaces SET ${fields.join(', ')} WHERE id = ?`, params);

  res.json({ success: true });
});

// Invite member (creates an invite notification instead of direct join)
router.post('/:id/members', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { username, role = 'member' } = req.body;

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const user = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (!user) {
    return res.status(404).json({ error: '用户不存在' });
  }

  const existing = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, user.id]
  );
  if (existing) {
    return res.status(400).json({ error: '用户已是该工作空间成员' });
  }

  const existingInvite = await db.get(
    `SELECT 1 FROM workspace_invites WHERE workspace_id = ? AND invitee_id = ? AND status = 'pending'`,
    [workspaceId, user.id]
  );
  if (existingInvite) {
    return res.status(400).json({ error: '已存在待处理的邀请' });
  }

  await db.run(
    `INSERT INTO workspace_invites (workspace_id, inviter_id, invitee_id, role, status) VALUES (?, ?, ?, ?, 'pending')`,
    [workspaceId, req.user.id, user.id, role]
  );

  res.status(201).json({ user_id: user.id, username, role, message: '邀请已发送' });
});

// Remove member
router.delete('/:id/members/:userId', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const targetUserId = parseInt(req.params.userId);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: '不能移除自己' });
  }

  await db.run(
    `DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, targetUserId]
  );

  res.json({ success: true });
});

// Get billing records for workspace
router.get('/:id/billing', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { page = 1, limit = 50 } = req.query;

  const membership = await db.get(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership) {
    return res.status(403).json({ error: '没有该工作空间的访问权限' });
  }

  const records = await db.all(
    `SELECT * FROM billing_records WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [workspaceId, parseInt(limit), (parseInt(page) - 1) * parseInt(limit)]
  );

  const total = await db.get(`SELECT COUNT(*) as count FROM billing_records WHERE workspace_id = ?`, [workspaceId]);

  res.json({ records, total: total?.count || 0, page: parseInt(page), limit: parseInt(limit) });
});

// List API keys for a workspace
router.get('/:id/keys', async (req, res) => {
  const workspaceId = parseInt(req.params.id);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership) {
    return res.status(403).json({ error: '没有该工作空间的访问权限' });
  }

  const keys = await db.all(`
    SELECT k.id, k.key_prefix, k.encrypted_key, k.name, k.is_active, k.max_concurrent, k.current_concurrent,
           k.total_requests, k.total_tokens, k.rate_limit, k.last_used_at, k.created_at,
           k.model_limit, k.group_limit, k.expires_at, k.quota_limit, k.quota_used, k.currency, k.quota_type
    FROM user_keys k
    WHERE k.workspace_id = ?
    ORDER BY k.created_at DESC
  `, [workspaceId]);

  const result = keys.map(k => ({
    ...k,
    key: k.encrypted_key ? db.decrypt(k.encrypted_key) : null
  }));

  res.json(result);
});

// Create API key for a workspace
router.post('/:id/keys', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { name, max_concurrent, rate_limit, model_limit, group_limit, expires_at, quota_limit, currency, quota_type } = req.body;

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const defaults = await getUserDefaults();
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const rawKey = `sk-${uuidv4().replace(/-/g, '').substring(0, 32)}`;
  const keyHash = bcrypt.hashSync(rawKey, 10);
  const keyPrefix = rawKey.substring(0, 12) + '...';
  const encryptedKey = db.encrypt(rawKey);

  const result = await db.run(
    `INSERT INTO user_keys (user_id, key_hash, key_prefix, encrypted_key, name, max_concurrent, rate_limit,
     model_limit, group_limit, expires_at, quota_limit, currency, quota_type, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id, keyHash, keyPrefix, encryptedKey, name || 'Workspace API Key',
      max_concurrent ?? defaults.max_concurrent, rate_limit || 60,
      model_limit || 'all', group_limit || 'all',
      expires_at || null, quota_limit || 0,
      currency || 'CNY', quota_type || 'tokens',
      workspaceId
    ]
  );

  apiKeyMiddleware.invalidateCache();

  res.status(201).json({
    id: result.lastInsertRowid,
    key: rawKey,
    key_prefix: keyPrefix,
    name: name || 'Workspace API Key'
  });
});

// Update API key for a workspace
router.put('/:id/keys/:keyId', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const keyId = parseInt(req.params.keyId);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const key = await db.get(
    `SELECT id FROM user_keys WHERE id = ? AND workspace_id = ?`,
    [keyId, workspaceId]
  );
  if (!key) {
    return res.status(404).json({ error: 'API Key 不存在' });
  }

  const { name, is_active, max_concurrent, rate_limit, model_limit, group_limit, expires_at, quota_limit, currency, quota_type } = req.body;
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(is_active === true || is_active === 'true' || is_active === 1); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent) || 500); }
  if (rate_limit !== undefined) { fields.push('rate_limit = ?'); params.push(parseInt(rate_limit) || 60); }
  if (model_limit !== undefined) { fields.push('model_limit = ?'); params.push(model_limit); }
  if (group_limit !== undefined) { fields.push('group_limit = ?'); params.push(group_limit); }
  if (expires_at !== undefined) { fields.push('expires_at = ?'); params.push(expires_at || null); }
  if (quota_limit !== undefined) {
    const ql = parseFloat(quota_limit);
    if (!isFinite(ql) || ql > 999999999999 || ql < 0) {
      return res.status(400).json({ error: { message: 'quota_limit out of range (max 999999999999.99999999)', type: 'invalid_request_error' } });
    }
    fields.push('quota_limit = ?'); params.push(ql);
  }
  if (currency !== undefined) { fields.push('currency = ?'); params.push(currency); }
  if (quota_type !== undefined) { fields.push('quota_type = ?'); params.push(quota_type); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });
  params.push(keyId);
  await db.run(`UPDATE user_keys SET ${fields.join(', ')} WHERE id = ?`, params);
  apiKeyMiddleware.invalidateCache();

  res.json({ success: true });
});

// Delete API key for a workspace
router.delete('/:id/keys/:keyId', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const keyId = parseInt(req.params.keyId);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const key = await db.get(
    `SELECT id FROM user_keys WHERE id = ? AND workspace_id = ?`,
    [keyId, workspaceId]
  );
  if (!key) {
    return res.status(404).json({ error: 'API Key 不存在' });
  }

  await db.run('DELETE FROM user_keys WHERE id = ?', [keyId]);
  apiKeyMiddleware.invalidateCache();
  res.json({ success: true });
});

// Delete workspace (owner only)
router.delete('/:id', async (req, res) => {
  const workspaceId = parseInt(req.params.id);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ error: '需要所有者权限' });
  }

  // Soft delete: mark as deleted
  await db.run(`UPDATE workspaces SET status = 'deleted' WHERE id = ?`, [workspaceId]);
  // Deactivate associated API keys
  await db.run(`UPDATE user_keys SET is_active = false WHERE workspace_id = ?`, [workspaceId]);
  apiKeyMiddleware.invalidateCache();

  res.json({ success: true });
});

// Reset workspace used quota by deducting balance
router.post('/:id/quota-reset', async (req, res) => {
  const workspaceId = parseInt(req.params.id);

  const membership = await db.get(
    `SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?`,
    [workspaceId, req.user.id]
  );
  if (!membership || !['owner', 'admin'].includes(membership.role)) {
    return res.status(403).json({ error: '需要管理员权限' });
  }

  const workspace = await db.get('SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
  if (!workspace) {
    return res.status(404).json({ error: '工作空间不存在' });
  }

  // Fixed cost for resetting used quota; must be a positive finite number.
  const cost = parseFloat(req.body.cost) || 0.1;
  if (!isFinite(cost) || cost <= 0) {
    return res.status(400).json({ error: '重置费用必须是正数' });
  }
  if (cost > 10000) {
    return res.status(400).json({ error: '重置费用超过上限' });
  }
  if ((workspace.balance || 0) < cost) {
    return res.status(400).json({ error: '余额不足，请先充值' });
  }

  const newBalance = normalizeBalance((workspace.balance || 0) - cost);
  await db.run('UPDATE workspaces SET quota_used = 0, token_quota_used = 0, balance = ? WHERE id = ?', [newBalance, workspaceId]);

  const user = await db.get('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  await db.run(
    `INSERT INTO billing_records (workspace_id, user_id, type, amount, balance_after, user_balance_after, description, metadata)
     VALUES (?, ?, 'consume', ?, ?, ?, ?, ?)`,
    [workspaceId, req.user.id, cost, newBalance, user?.balance || 0, '额度重置', JSON.stringify({ action: 'quota_reset', previous_quota_used: workspace.quota_used })]
  );

  res.json({ success: true, balance: newBalance, quota_used: 0 });
});

module.exports = router;
