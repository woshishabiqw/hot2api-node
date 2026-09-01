/**
 * @swagger
 * tags:
 *   name: Admin
 *   description: Admin management APIs
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const db = require('../config/database');
const config = require('../config/settings');
const audit = require('../services/audit');
const cacheService = require('../services/cache');
const cacheManager = require('../services/cache-manager');
const { generateNginxConfig } = require('../../../scripts/generate-nginx-conf');
const { readNginxControl } = require('../../../scripts/nginx-control');
const { authMiddleware, adminMiddleware, revokeAllUserTokens } = require('../middleware/auth');
const { validatePassword } = require('../utils/password-policy');
const keyChecker = require('../services/key-checker');
const dispatcher = require('../services/dispatcher');
const probeService = require('../services/probe');
const smartRoutingService = require('../services/smart-routing');
const routingConfig = require('../services/routing-config');
const routingLoader = require('../services/routing-loader');
const sessionTracker = require('../middleware/session-tracker');
const apiKeyMiddleware = require('../middleware/apikey');
const rateLimitMiddleware = require('../middleware/rate-limit');
const requireSecondAuthForMutations = require('../middleware/require-second-auth');
const { getStatus: getRedisStatus, getConfig: getRedisConfig, reconnect: reconnectRedis } = require('../config/redis');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const adminEvents = require('../services/admin-events');
const logManagement = require('../services/log-management');
const transitScanner = require('../services/transit-scanner');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_CONFIG_FILE = path.join(PROJECT_ROOT, 'config', 'server.json');
const NGINX_DIR = path.join(PROJECT_ROOT, 'nginx');
const NGINX_START_SCRIPT = path.join(NGINX_DIR, 'start.js');

function isValidPort(p) {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 && n <= 65535;
}

function isNginxRunning() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', 'IMAGENAME eq nginx.exe', '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(stdout.toLowerCase().includes('nginx.exe'));
      });
    } else {
      execFile('pgrep', ['nginx'], (err) => resolve(!err));
    }
  });
}

function getNginxProcessInfo() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const os = require('os');
      const tmpFile = path.join(os.tmpdir(), `nginx-ps-${Date.now()}.json`);
      const script = `Get-Process nginx -ErrorAction SilentlyContinue | Select-Object Path, Id | ConvertTo-Json -Compress | Out-File -FilePath '${tmpFile.replace(/'/g, "''")}' -Encoding utf8`;
      execFile('powershell', ['-Command', script], { encoding: 'utf8', windowsHide: true }, (err) => {
        if (err) return resolve([]);
        try {
          const data = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
          fs.unlinkSync(tmpFile);
          const list = Array.isArray(data) ? data : [data];
          resolve(list.filter(p => p && p.Path).map(p => ({ pid: p.Id, path: p.Path })));
        } catch (e) {
          try { fs.unlinkSync(tmpFile); } catch (_) {}
          resolve([]);
        }
      });
    } else {
      execFile('pgrep', ['nginx'], (err, stdout) => {
        if (err) return resolve([]);
        const pids = stdout.split('\n').map(s => s.trim()).filter(Boolean);
        const results = [];
        let pending = pids.length;
        if (pending === 0) return resolve([]);
        pids.forEach((pid) => {
          execFile('readlink', [`/proc/${pid}/exe`], (err2, exePath) => {
            results.push({ pid, path: err2 ? '' : (exePath || '').trim() });
            pending--;
            if (pending === 0) resolve(results);
          });
        });
      });
    }
  });
}

function isValidAllowlistCidr(cidr) {
  if (typeof cidr !== 'string') return false;
  const [addr, prefix] = cidr.split('/');
  if (!addr) return false;
  // IPv4
  const ipv4Parts = addr.split('.');
  if (ipv4Parts.length === 4) {
    for (const part of ipv4Parts) {
      const n = parseInt(part, 10);
      if (Number.isNaN(n) || n < 0 || n > 255) return false;
    }
    if (prefix !== undefined) {
      const p = parseInt(prefix, 10);
      if (Number.isNaN(p) || p < 0 || p > 32) return false;
    }
    return true;
  }
  // IPv6: accept a conservative subset via a simple regex
  if (/^([0-9a-fA-F:]+)(\/(\d{1,3}))?$/.test(addr)) {
    if (prefix !== undefined) {
      const p = parseInt(prefix, 10);
      if (Number.isNaN(p) || p < 0 || p > 128) return false;
    }
    return true;
  }
  return false;
}

function normalizeServerConfig(body, current) {
  const next = JSON.parse(JSON.stringify(current));
  if (!next.ports) next.ports = {};
  if (!next.nginx) next.nginx = {};

  const portKeys = ['api', 'admin', 'user'];
  for (const key of portKeys) {
    if (body.ports?.[key] !== undefined) {
      next.ports[key] = Number(body.ports[key]);
    }
  }

  if (body.trust_proxy !== undefined) {
    next.trust_proxy = body.trust_proxy === true || body.trust_proxy === 'true';
  }

  if (body.nginx?.user_listen !== undefined) next.nginx.user_listen = Number(body.nginx.user_listen);
  if (body.nginx?.admin_listen !== undefined) next.nginx.admin_listen = Number(body.nginx.admin_listen);
  if (body.nginx?.server_name !== undefined) {
    const raw = unescapeHtml(body.nginx.server_name);
    next.nginx.server_name = typeof raw === 'string' ? raw.trim() : next.nginx.server_name;
  }

  // Nginx security settings are only accepted when the project controls the bundled Nginx.
  const control = readNginxControl(PROJECT_ROOT);
  if (control.controlled === true && body.nginx?.security) {
    const s = body.nginx.security;
    next.nginx.security = {
      server_tokens: s.server_tokens === true,
      security_headers: s.security_headers === true,
      admin_ip_allowlist: Array.isArray(s.admin_ip_allowlist)
        ? s.admin_ip_allowlist.filter(Boolean).map(unescapeHtml)
        : [],
      rate_limit: {
        enabled: s.rate_limit?.enabled === true,
        rps: Number(s.rate_limit?.rps) || 10,
        burst: Number(s.rate_limit?.burst) || 20,
      },
      timeouts: {
        client_body: Number(s.timeouts?.client_body) || 0,
        client_header: Number(s.timeouts?.client_header) || 0,
        send: Number(s.timeouts?.send) || 0,
      },
    };
  }

  return next;
}

function validateSecurityConfig(cfg) {
  const security = cfg.nginx?.security;
  if (!security) return null;

  if (security.admin_ip_allowlist) {
    for (const cidr of security.admin_ip_allowlist) {
      if (!isValidAllowlistCidr(cidr)) {
        return `管理后台 IP 白名单包含无效 CIDR: ${cidr}`;
      }
    }
  }

  if (security.rate_limit) {
    if (security.rate_limit.rps < 1 || security.rate_limit.rps > 10000) {
      return '限速 rps 必须在 1-10000 之间';
    }
    if (security.rate_limit.burst < 1 || security.rate_limit.burst > 100000) {
      return '限速 burst 必须在 1-100000 之间';
    }
  }

  if (security.timeouts) {
    const { client_body, client_header, send } = security.timeouts;
    if (client_body && (client_body < 1 || client_body > 3600)) return 'client_body_timeout 超出范围';
    if (client_header && (client_header < 1 || client_header > 3600)) return 'client_header_timeout 超出范围';
    if (send && (send < 1 || send > 3600)) return 'send_timeout 超出范围';
  }

  return null;
}

function validateServerConfig(cfg) {
  const portMap = {};
  const check = (label, value) => {
    if (!isValidPort(value)) return `端口 ${label} 必须是 1-65535 的整数`;
    if (portMap[value]) return `端口 ${label} 与 ${portMap[value]} 冲突`;
    portMap[value] = label;
  };

  let err = check('Node.js API', cfg.ports?.api);
  if (err) return err;
  err = check('Node.js Admin', cfg.ports?.admin);
  if (err) return err;
  err = check('Node.js User', cfg.ports?.user);
  if (err) return err;
  err = check('Nginx User', cfg.nginx?.user_listen);
  if (err) return err;
  err = check('Nginx Admin', cfg.nginx?.admin_listen);
  if (err) return err;

  if (!cfg.nginx?.server_name) return 'Nginx server_name 不能为空';
  return null;
}

function configRequiresRestart(before, after) {
  if (!before.ports || !after.ports) return false;
  return before.ports.api !== after.ports.api
    || before.ports.admin !== after.ports.admin
    || before.ports.user !== after.ports.user;
}

function reloadNginx() {
  return new Promise((resolve) => {
    execFile('node', [NGINX_START_SCRIPT, '--reload'], { cwd: NGINX_DIR, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        console.error('[Admin] Nginx reload failed:', err.message, stderr);
        return resolve({ success: false, message: err.message || String(stderr) });
      }
      resolve({ success: true });
    });
  });
}

// Reverse the generic HTML escaping applied by the security middleware for
// functional JSON/text settings that must be stored verbatim.
function unescapeHtml(str) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Cached default config for new users/keys to avoid repeated DB reads on hot path.
let _userDefaultsCache = null;
let _userDefaultsCacheTs = 0;
const USER_DEFAULTS_CACHE_TTL_MS = 5000;

async function getUserDefaults() {
  const now = Date.now();
  if (_userDefaultsCache && (now - _userDefaultsCacheTs) < USER_DEFAULTS_CACHE_TTL_MS) {
    return _userDefaultsCache;
  }
  const row = await db.get('SELECT * FROM user_defaults ORDER BY id LIMIT 1');
  _userDefaultsCache = row || { tpm: 10000000, rpm: 100, tpd: 1000000000, max_concurrent: 100 };
  _userDefaultsCacheTs = now;
  return _userDefaultsCache;
}

// ========== Source cache / concurrency helpers ==========

/**
 * 按源站失效相关缓存：路由缓存 + 仪表盘统计缓存。
 * 使用 CacheManager 的标签机制，避免手动记 key。
 */
async function invalidateSourceRoutingCache(sourceId) {
  try {
    await dispatcher._clearCacheBySourceId(sourceId);
  } catch (e) {
    console.error('[admin] failed to clear routing cache for source', sourceId, e.message);
  }
  await cacheManager.invalidateTags([`source:${sourceId}`, 'admin:stats']);
}

/**
 * 重置源站并发计数：数据库 current_concurrent 与内存 concurrentMap。
 * 在禁用/删除源站时调用，避免已禁用的源站仍然显示非零并发。
 */
async function resetSourceConcurrent(sourceId) {
  try {
    await db.run('UPDATE sources SET current_concurrent = 0 WHERE id = ?', [sourceId]);
  } catch (e) {
    console.error('[admin] failed to reset DB concurrent for source', sourceId, e.message);
  }
  try {
    dispatcher.concurrentMap.delete(sourceId);
  } catch (e) {
    console.error('[admin] failed to reset memory concurrent for source', sourceId, e.message);
  }
}

/**
 * 清除所有源站路由缓存（用于批量操作、新增源站、源站组变更等）。
 */
async function invalidateAllSourceRouting() {
  await cacheManager.invalidateNamespaces(['routing', 'admin:stats']);
}

/**
 * 模型相关缓存失效：路由、代理模型信息、仪表盘统计。
 */
async function invalidateModelRelatedCache() {
  await cacheManager.invalidateTags(['routing', 'proxy', 'admin:stats']);
}

const STALE_STATUS_THRESHOLD_MS = 10 * 60 * 1000; // 10 分钟视为检测过期

/**
 * 计算源站的综合状态，避免"状态显示正常但 Key/检测系统实际未启动"的误导。
 */
function formatStatusDetail(statusCode, detail) {
  const parts = [];
  if (statusCode != null) parts.push(`HTTP ${statusCode}`);
  if (detail) parts.push(String(detail));
  return parts.join(' · ');
}

function getEffectiveSourceStatus(source) {
  const now = Date.now();
  const rawStatus = source.status || 'unknown';
  const isActive = source.is_active === 1 || source.is_active === true;
  const lastCheckAt = source.last_check_at || source.direct_last_check || null;
  const lastCheckMs = lastCheckAt ? new Date(lastCheckAt).getTime() : 0;
  const directDisabledUntil = source.direct_disabled_until
    ? new Date(source.direct_disabled_until).getTime()
    : 0;
  const isDirectDisabled = source.direct_status === 'disabled' || directDisabledUntil > now;
  const statusCode = source.last_check_status_code ?? null;
  const detail = source.last_check_detail || '';

  let effective = rawStatus;
  let label = '';
  let variant = 'secondary';
  let reason = '';

  if (!isActive) {
    effective = 'inactive';
    label = '已禁用';
    variant = 'secondary';
    reason = '源站已被手动禁用';
  } else if (isDirectDisabled) {
    effective = 'direct_disabled';
    label = '路由禁用';
    variant = 'warning';
    reason = '智能路由已禁用该源站的直通访问';
  } else if (rawStatus === 'valid' && lastCheckMs && (now - lastCheckMs > STALE_STATUS_THRESHOLD_MS)) {
    effective = 'stale';
    label = '检测过期';
    variant = 'warning';
    reason = `最后检测于 ${Math.round((now - lastCheckMs) / 60000)} 分钟前`;
  } else if (rawStatus === 'unknown' && !lastCheckMs) {
    effective = 'untested';
    label = '未检测';
    variant = 'secondary';
    reason = '源站尚未完成 Key 检测或健康探测';
  } else {
    const statusMap = {
      valid: { label: '有效', variant: 'success', reason: '源站 Key/网络检测正常' },
      checking: { label: '失效中', variant: 'warning', reason: 'Key 疑似失效，正在重试确认' },
      invalid: { label: '停用', variant: 'destructive', reason: 'Key 已失效' },
      insufficient: { label: '余额不足', variant: 'warning', reason: '余额不足或触发限速' },
      unavailable: { label: '源站不可用', variant: 'warning', reason: '源站服务暂时不可用' },
      error: { label: '错误', variant: 'destructive', reason: '源站网络/服务错误' },
      unknown: { label: '未知', variant: 'secondary', reason: '状态未知' }
    };
    const mapped = statusMap[rawStatus] || statusMap.unknown;
    label = mapped.label;
    variant = mapped.variant;
    reason = mapped.reason;
  }

  // 把最近一次检测的 HTTP 状态码与详细错误追加到 tooltip 中
  const detailText = formatStatusDetail(statusCode, detail);
  const fullReason = detailText ? `${reason}\n${detailText}` : reason;

  return {
    effective_status: effective,
    label,
    variant,
    reason: fullReason,
    short_reason: reason,
    status_code: statusCode,
    detail,
    last_check_at: lastCheckAt,
    last_check_text: lastCheckMs ? new Date(lastCheckMs).toLocaleString() : '无',
    raw_status: rawStatus,
    direct_status: source.direct_status || 'enabled',
    direct_disabled_until: source.direct_disabled_until || null
  };
}

/**
 * 判断单个源站成员在 dispatcher 的实例展开中是否“真正可用”。
 * 规则与 dispatcher.selectSource 中实例成员筛选保持一致。
 */
function isMemberRoutable(member) {
  if (!member) return false;
  if (member.is_active === false || member.is_active === 0) return false;
  if (member.source_is_active === false || member.source_is_active === 0) return false;
  if (['invalid', 'error'].includes(member.source_status)) return false;
  const quotaLimit = Number(member.quota_limit) || 0;
  const quotaUsed = Number(member.quota_used) || 0;
  if (quotaLimit > 0 && quotaUsed >= quotaLimit) return false;
  if (member.direct_status === 'disabled') return false;
  const disabledUntil = member.direct_disabled_until
    ? new Date(member.direct_disabled_until).getTime()
    : 0;
  if (disabledUntil > Date.now()) return false;
  return true;
}

/**
 * 计算模型的“路由状态”与“均衡状态”。
 * 逻辑与 dispatcher.getAvailableSources / selectSource 保持一致，避免前后端显示冲突。
 */
function computeModelRoutingStatus(model, source, instances, instanceMembers) {
  const eff = getEffectiveSourceStatus(source || {});
  const rawStatus = source?.status || 'unknown';
  const quotaLimit = Number(source?.quota_limit) || 0;
  const quotaUsed = Number(source?.quota_used) || 0;
  const quotaExceeded = quotaLimit > 0 && quotaUsed >= quotaLimit;

  // ---- 路由状态：模型是否可被用户请求命中 ----
  let routing = { status: 'active', label: '可用', variant: 'success', reason: '模型与源站均正常' };

  if (!model.is_active) {
    routing = { status: 'inactive', label: '已禁用', variant: 'secondary', reason: '模型已被手动禁用' };
  } else if (!source || source.is_active === false || source.is_active === 0) {
    routing = { status: 'source_inactive', label: '源站已禁用', variant: 'destructive', reason: '所属源站已被手动禁用' };
  } else if (quotaExceeded) {
    routing = { status: 'quota_exceeded', label: '额度耗尽', variant: 'warning', reason: `源站额度已用完 (${quotaUsed.toLocaleString()} / ${quotaLimit.toLocaleString()})` };
  } else if (eff.effective_status === 'direct_disabled') {
    routing = { status: 'direct_disabled', label: '路由禁用', variant: 'warning', reason: eff.short_reason || '智能路由已禁用该源站的直通访问' };
  } else if (eff.effective_status === 'untested') {
    routing = { status: 'untested', label: '未检测', variant: 'secondary', reason: '源站尚未完成 Key 检测或健康探测' };
  } else if (eff.effective_status === 'unknown') {
    routing = { status: 'unhealthy', label: '未知', variant: 'warning', reason: eff.short_reason || '源站状态未知，最近一次检测未成功' };
  } else if (['checking', 'insufficient', 'unavailable', 'error', 'invalid'].includes(rawStatus)) {
    const labels = {
      checking: { label: '失效中', reason: 'Key 疑似失效，正在重试确认' },
      insufficient: { label: '余额不足', reason: '余额不足或触发限速' },
      unavailable: { label: '源站不可用', reason: '源站服务暂时不可用' },
      error: { label: '错误', reason: '源站网络/服务错误' },
      invalid: { label: '停用', reason: 'Key 已失效' }
    };
    const mapped = labels[rawStatus];
    routing = { status: 'unhealthy', label: mapped.label, variant: 'warning', reason: mapped.reason };
  } else if (eff.effective_status === 'stale') {
    routing = { status: 'stale', label: '检测过期', variant: 'warning', reason: eff.short_reason || '源站检测数据已过期' };
  }

  // ---- 均衡状态：请求进来后如何分发 ----
  let balance = { mode: 'direct', label: '直连', variant: 'secondary', reason: '请求直接走所属源站', stack_mode: null, instance_name: null, group_name: null, active_members: 0, total_members: 0 };

  if (routing.status !== 'active') {
    balance = { ...balance, label: routing.label, variant: routing.variant, reason: routing.reason, mode: routing.status };
  } else if (source?.source_group) {
    const stackMode = source.stack_mode || 'merged';
    const isMerged = stackMode === 'merged';
    balance = {
      mode: 'source_group',
      label: isMerged ? '负载均衡' : '主备切换',
      variant: 'success',
      reason: isMerged ? `虚拟源站组 ${source.source_group}：合并并发后选择负载最低成员` : `虚拟源站组 ${source.source_group}：按顺序选择首个可用成员`,
      stack_mode: stackMode,
      group_name: source.source_group,
      instance_name: null,
      active_members: 0,
      total_members: 0
    };
  } else if (model.instance_id) {
    const inst = instances.find(i => i.id === model.instance_id);
    const members = instanceMembers.filter(m => m.instance_id === model.instance_id);
    const activeMembers = members.filter(isMemberRoutable);
    const isMerged = inst?.stack_mode === 'merged';

    if (!inst || inst.is_active === false || inst.is_active === 0) {
      balance = {
        mode: 'instance_inactive',
        label: '实例已禁用',
        variant: 'destructive',
        reason: `均衡实例 ${inst?.name || model.instance_id} 已被禁用，请求不会进入该实例`,
        stack_mode: inst?.stack_mode || 'merged',
        group_name: null,
        instance_name: inst?.name || null,
        active_members: activeMembers.length,
        total_members: members.length
      };
    } else if (activeMembers.length === 0) {
      balance = {
        mode: 'instance_unavailable',
        label: '均衡不可用',
        variant: 'destructive',
        reason: `均衡实例 ${inst?.name || ''} 暂无可用成员（成员被禁用/状态异常/路由禁用/额度耗尽）`,
        stack_mode: inst?.stack_mode || 'merged',
        group_name: null,
        instance_name: inst?.name || null,
        active_members: 0,
        total_members: members.length
      };
    } else {
      balance = {
        mode: 'instance',
        label: isMerged ? '均衡中' : '主备切换',
        variant: 'success',
        reason: isMerged
          ? `均衡实例 ${inst.name}：在 ${activeMembers.length}/${members.length} 个可用成员间按评分负载均衡`
          : `均衡实例 ${inst.name}：按评分排序选择首个可用成员（${activeMembers.length}/${members.length} 可用）`,
        stack_mode: inst?.stack_mode || 'merged',
        group_name: null,
        instance_name: inst?.name || null,
        active_members: activeMembers.length,
        total_members: members.length
      };
    }
  }

  return { routing_status: routing, balance_status: balance, effective_source_status: eff };
}

// Probe SSE endpoint - must be before global middleware to support token query parameter
router.get('/sources/probe/stream', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).end();
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;

    if (decoded.role !== 'admin') {
      return res.status(403).end();
    }
  } catch (e) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  probeService.addClient(res);
});

// Generic admin SSE endpoint - push real-time changes to admin dashboard
router.get('/events/stream', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).end();
  }

  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, config.jwt.secret);
    req.user = decoded;

    if (decoded.role !== 'admin') {
      return res.status(403).end();
    }
  } catch (e) {
    return res.status(401).end();
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  adminEvents.addClient(res);
});

router.use(authMiddleware, adminMiddleware);

// 二级密码仅对用户管理相关路由的写操作生效
router.use('/registration', requireSecondAuthForMutations);
router.use('/users', requireSecondAuthForMutations);
router.use('/keys', requireSecondAuthForMutations);

/**
 * @swagger
 * /admin/sources:
 *   get:
 *     summary: List all sources
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of sources
 */
router.get('/source-groups', async (req, res) => {
  const sources = await db.all(`
    SELECT s.*, m.model_id, m.model_alias
    FROM sources s
    LEFT JOIN models m ON s.id = m.source_id
    WHERE s.source_group IS NOT NULL AND s.source_group != ''
    ORDER BY s.source_group, s.id
  `);

  const groups = new Map();
  for (const s of sources) {
    if (!groups.has(s.source_group)) {
      groups.set(s.source_group, {
        name: s.source_group,
        stack_mode: s.stack_mode || 'merged',
        sources: new Map()
      });
    }
    const group = groups.get(s.source_group);
    if (!group.sources.has(s.id)) {
      // Use the live in-memory concurrent count instead of the stale DB column
      const liveCurrent = dispatcher.concurrentMap?.get(s.id) ?? s.current_concurrent ?? 0;
      group.sources.set(s.id, {
        id: s.id,
        name: s.name,
        current_concurrent: liveCurrent,
        max_concurrent: s.max_concurrent,
        status: s.status,
        models: []
      });
    }
    if (s.model_id && !group.sources.get(s.id).models.includes(s.model_id)) {
      group.sources.get(s.id).models.push(s.model_id);
    }
    if (s.model_alias && s.model_alias !== s.model_id && !group.sources.get(s.id).models.includes(s.model_alias)) {
      group.sources.get(s.id).models.push(s.model_alias);
    }
  }

  const result = [];
  for (const [, group] of groups) {
    const sourceList = Array.from(group.sources.values());
    result.push({
      name: group.name,
      stack_mode: group.stack_mode,
      sources: sourceList,
      total_max_concurrent: sourceList.reduce((sum, s) => sum + s.max_concurrent, 0),
      total_current_concurrent: sourceList.reduce((sum, s) => sum + s.current_concurrent, 0)
    });
  }

  res.json(result);
});

router.put('/source-groups/:name/stack-mode', async (req, res) => {
  const { name } = req.params;
  const { stack_mode } = req.body;
  if (!['merged', 'failover'].includes(stack_mode)) {
    return res.status(400).json({ error: 'stack_mode must be "merged" or "failover"' });
  }
  await db.run('UPDATE sources SET stack_mode = ? WHERE source_group = ?', [stack_mode, name]);
  res.json({ success: true });
  adminEvents.broadcast('source-groups.changed', { type: 'updated', name });
  await invalidateAllSourceRouting();
});

// ── Instances ──

function asNumber(v, def) {
  const n = parseFloat(v);
  return Number.isNaN(n) ? def : n;
}

function asBool(v, def) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1;
  if (typeof v === 'string') return v === 'true' || v === '1' || v === 'yes';
  return def;
}

function buildOutboundModelValues(sid, finalOutbound, inboundModel, cfg = {}) {
  const inboundSourceModelId = inboundModel.source_model_id || inboundModel.model_id;
  return {
    source_id: sid,
    model_id: finalOutbound,
    source_model_id: cfg.source_model_id !== undefined ? cfg.source_model_id : inboundSourceModelId,
    model_alias: cfg.model_alias !== undefined ? cfg.model_alias : finalOutbound,
    input_price: asNumber(cfg.input_price, inboundModel.input_price),
    input_price_cache: asNumber(cfg.input_price_cache, inboundModel.input_price_cache),
    output_price: asNumber(cfg.output_price, inboundModel.output_price),
    max_tokens: asNumber(cfg.max_tokens, inboundModel.max_tokens),
    is_vision: asBool(cfg.is_vision, !!inboundModel.is_vision),
    priority: asNumber(cfg.priority, inboundModel.priority),
    description: cfg.description !== undefined ? cfg.description : inboundModel.description,
    supports_tools: asBool(cfg.supports_tools, !!inboundModel.supports_tools),
    supports_json: asBool(cfg.supports_json, !!inboundModel.supports_json),
    supports_fim: asBool(cfg.supports_fim, !!inboundModel.supports_fim),
    max_concurrent: asNumber(cfg.max_concurrent, inboundModel.max_concurrent),
    model_group: cfg.model_group !== undefined ? cfg.model_group : inboundModel.model_group,
    completion_price: asNumber(cfg.completion_price, inboundModel.completion_price),
    rate_multiplier: asNumber(cfg.rate_multiplier, inboundModel.rate_multiplier)
  };
}

router.get('/instances', async (req, res) => {
  const instances = await db.all('SELECT * FROM instances ORDER BY created_at DESC');
  const members = await db.all('SELECT im.*, s.name as source_name, s.status as source_status FROM instance_members im JOIN sources s ON im.source_id = s.id');
  const result = instances.map(inst => ({
    ...inst,
    members: members.filter(m => m.instance_id === inst.id)
  }));
  res.json(result);
});

router.post('/instances', async (req, res) => {
  const { name, inbound_model_id, inbound_source_id, outbound_model_id, stack_mode, member_source_ids, outbound_configs = {} } = req.body;
  if (!name || !inbound_model_id || !inbound_source_id) {
    return res.status(400).json({ error: 'name, inbound_model_id, inbound_source_id are required' });
  }
  if (!member_source_ids || member_source_ids.length === 0) {
    return res.status(400).json({ error: '请至少选择一个均衡源站' });
  }
  if (!['merged', 'failover'].includes(stack_mode || 'merged')) {
    return res.status(400).json({ error: 'stack_mode must be "merged" or "failover"' });
  }

  // 校验入站模型存在
  const inboundModel = await db.get(
    'SELECT * FROM models WHERE model_id = ? AND source_id = ? LIMIT 1',
    [inbound_model_id, inbound_source_id]
  );
  if (!inboundModel) {
    return res.status(400).json({ error: '入站模型不存在' });
  }

  // 出站模型ID防冲突校验
  const outbound = outbound_model_id || inbound_model_id;
  let finalOutbound = outbound;
  let suffix = 1;
  while (await db.get('SELECT 1 FROM models WHERE model_id = ? LIMIT 1', [finalOutbound])) {
    finalOutbound = `${outbound}_${suffix}`;
    suffix++;
  }

  // 校验唯一
  if (await db.get('SELECT 1 FROM instances WHERE outbound_model_id = ? LIMIT 1', [finalOutbound])) {
    return res.status(400).json({ error: '出站模型ID已存在' });
  }

  const instanceResult = await db.run(
    `INSERT INTO instances (name, inbound_model_id, inbound_source_id, outbound_model_id, stack_mode)
     VALUES (?, ?, ?, ?, ?)`,
    [name, inbound_model_id, inbound_source_id, finalOutbound, stack_mode || 'merged']
  );
  const instanceId = instanceResult.lastInsertRowid;

  // 插入成员（入站源站 + 均衡源站）及对应的出站模型
  const allMemberIds = [inbound_source_id, ...(member_source_ids || []).filter(id => id !== inbound_source_id)];
  for (const sid of allMemberIds) {
    await db.run(
      'INSERT INTO instance_members (instance_id, source_id) VALUES (?, ?)',
      [instanceId, sid]
    );
    const v = buildOutboundModelValues(sid, finalOutbound, inboundModel, outbound_configs[String(sid)]);
    await db.run(
      `INSERT INTO models (source_id, model_id, source_model_id, model_alias, input_price, input_price_cache, output_price,
        max_tokens, is_vision, is_active, priority, description, supports_tools, supports_json, supports_fim,
        max_concurrent, model_group, completion_price, rate_multiplier, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        v.source_id, v.model_id, v.source_model_id, v.model_alias,
        v.input_price, v.input_price_cache, v.output_price,
        v.max_tokens, v.is_vision, 1, v.priority,
        v.description, v.supports_tools, v.supports_json, v.supports_fim,
        v.max_concurrent, v.model_group, v.completion_price, v.rate_multiplier, instanceId
      ]
    );
  }

  res.status(201).json({ id: instanceId, name, outbound_model_id: finalOutbound });
  adminEvents.broadcast('instances.changed', { type: 'created', id: instanceId });
  adminEvents.broadcast('sources.changed', { type: 'models_updated', instanceId });
});

router.delete('/instances/:id', async (req, res) => {
  const { id } = req.params;
  await db.run('DELETE FROM models WHERE instance_id = ?', [parseInt(id)]);
  await db.run('DELETE FROM instances WHERE id = ?', [parseInt(id)]);
  res.json({ success: true });
  adminEvents.broadcast('instances.changed', { type: 'deleted', id: parseInt(id) });
  adminEvents.broadcast('sources.changed', { type: 'models_updated', instanceId: parseInt(id) });
});

router.put('/instances/:id', async (req, res) => {
  const { id } = req.params;
  const { name, outbound_model_id, stack_mode, is_active } = req.body;
  const instance = await db.get('SELECT * FROM instances WHERE id = ?', [parseInt(id)]);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (stack_mode !== undefined) {
    if (!['merged', 'failover'].includes(stack_mode)) {
      return res.status(400).json({ error: 'stack_mode must be "merged" or "failover"' });
    }
    fields.push('stack_mode = ?'); params.push(stack_mode);
  }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (outbound_model_id !== undefined && outbound_model_id !== instance.outbound_model_id) {
    const exists = await db.get('SELECT 1 FROM instances WHERE outbound_model_id = ? AND id != ? LIMIT 1', [outbound_model_id, parseInt(id)]);
    if (exists) return res.status(400).json({ error: '出站模型ID已存在' });
    fields.push('outbound_model_id = ?'); params.push(outbound_model_id);
    // 同步更新 models 表中的 model_id
    await db.run('UPDATE models SET model_id = ? WHERE instance_id = ? AND model_id = ?', [outbound_model_id, parseInt(id), instance.outbound_model_id]);
  }

  if (fields.length > 0) {
    params.push(parseInt(id));
    await db.run(`UPDATE instances SET ${fields.join(', ')} WHERE id = ?`, params);
  }
  res.json({ success: true });
  adminEvents.broadcast('instances.changed', { type: 'updated', id: parseInt(id) });
});

router.put('/instances/:id/members', async (req, res) => {
  const { id } = req.params;
  const { member_source_ids, outbound_configs = {} } = req.body;
  const instance = await db.get('SELECT * FROM instances WHERE id = ?', [parseInt(id)]);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  const inboundModel = await db.get(
    'SELECT * FROM models WHERE model_id = ? AND source_id = ? LIMIT 1',
    [instance.inbound_model_id, instance.inbound_source_id]
  );

  // 获取现有成员
  const existing = await db.all('SELECT source_id FROM instance_members WHERE instance_id = ?', [parseInt(id)]);
  const existingIds = new Set(existing.map(m => m.source_id));
  const newIds = new Set([instance.inbound_source_id, ...member_source_ids.filter(sid => sid !== instance.inbound_source_id)]);

  // 删除不再需要的成员（不能删除入站源站）
  for (const sid of existingIds) {
    if (!newIds.has(sid) && sid !== instance.inbound_source_id) {
      await db.run('DELETE FROM instance_members WHERE instance_id = ? AND source_id = ?', [parseInt(id), sid]);
      await db.run('DELETE FROM models WHERE instance_id = ? AND source_id = ? AND model_id = ?', [parseInt(id), sid, instance.outbound_model_id]);
    }
  }

  // 新增成员，并同步更新已有出站模型配置
  for (const sid of newIds) {
    const cfg = outbound_configs[String(sid)] || {};
    if (!existingIds.has(sid)) {
      await db.run('INSERT INTO instance_members (instance_id, source_id) VALUES (?, ?)', [parseInt(id), sid]);
    }
    const v = buildOutboundModelValues(sid, instance.outbound_model_id, inboundModel, cfg);
    if (existingIds.has(sid)) {
      await db.run(
        `UPDATE models SET source_model_id = ?, model_alias = ?, input_price = ?, input_price_cache = ?, output_price = ?,
          max_tokens = ?, is_vision = ?, priority = ?, description = ?, supports_tools = ?, supports_json = ?,
          supports_fim = ?, max_concurrent = ?, model_group = ?, completion_price = ?, rate_multiplier = ?
         WHERE instance_id = ? AND source_id = ? AND model_id = ?`,
        [
          v.source_model_id, v.model_alias, v.input_price, v.input_price_cache, v.output_price,
          v.max_tokens, v.is_vision, v.priority, v.description,
          v.supports_tools, v.supports_json, v.supports_fim, v.max_concurrent, v.model_group,
          v.completion_price, v.rate_multiplier, parseInt(id), sid, instance.outbound_model_id
        ]
      );
    } else {
      await db.run(
        `INSERT INTO models (source_id, model_id, source_model_id, model_alias, input_price, input_price_cache, output_price,
          max_tokens, is_vision, is_active, priority, description, supports_tools, supports_json, supports_fim,
          max_concurrent, model_group, completion_price, rate_multiplier, instance_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.source_id, v.model_id, v.source_model_id, v.model_alias,
          v.input_price, v.input_price_cache, v.output_price,
          v.max_tokens, v.is_vision, 1, v.priority,
          v.description, v.supports_tools, v.supports_json, v.supports_fim,
          v.max_concurrent, v.model_group, v.completion_price, v.rate_multiplier, parseInt(id)
        ]
      );
    }
  }

  res.json({ success: true });
  adminEvents.broadcast('instances.changed', { type: 'members_updated', id: parseInt(id) });
  adminEvents.broadcast('sources.changed', { type: 'models_updated', instanceId: parseInt(id) });
});

router.get('/sources', async (req, res) => {
  const sources = await db.all('SELECT * FROM sources ORDER BY created_at DESC');
  const decrypted = await Promise.all(sources.map(async s => {
    const result = { ...s, api_key: db.decrypt(s.api_key) };
    if (s.api_keys) {
      try {
        const keys = JSON.parse(s.api_keys);
        result.api_keys = {};
        for (const [proto, key] of Object.entries(keys)) {
          result.api_keys[proto] = db.decrypt(key);
        }
      } catch (e) { result.api_keys = {}; }
    } else {
      result.api_keys = {};
    }
    if (s.api_urls) {
      try {
        let parsed = JSON.parse(s.api_urls);
        // 防御双重 JSON 字符串化：parse 后仍是字符串则再 parse 一次
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        result.api_urls = parsed;
      } catch (e) { result.api_urls = {}; }
    } else {
      result.api_urls = {};
    }

    // 自动迁移旧数据：如果 api_urls 为空但 base_url 存在，用 protocol + base_url 填充
    if (Object.keys(result.api_urls).length === 0 && result.base_url) {
      const proto = result.protocol || 'openai';
      if (proto === 'relay') {
        // relay 模式：给所有协议都填上 base_url
        for (const p of ['openai', 'anthropic', 'gemini', 'bedrock']) {
          result.api_urls[p] = result.base_url;
        }
      } else {
        result.api_urls[proto] = result.base_url;
      }
      // 回写到数据库
      await db.run('UPDATE sources SET api_urls = ? WHERE id = ?', [JSON.stringify(result.api_urls), s.id]);
    }

    result.effective_status = getEffectiveSourceStatus(result);
    return result;
  }));
  res.json(decrypted);
});

router.post('/sources', async (req, res) => {
  const { name, base_url, protocol, api_key, api_keys, api_urls, weight, max_concurrent, source_group, balance_group, stack_mode, quota_limit, strip_tools } = req.body;

  if (!name || !api_key) {
    return res.status(400).json({ error: 'name and api_key are required' });
  }

  // 如果没有 base_url，从 api_urls 中取第一个非空的
  let effectiveBaseUrl = base_url;
  if (!effectiveBaseUrl && api_urls) {
    effectiveBaseUrl = Object.values(api_urls).find(u => u) || '';
  }
  if (!effectiveBaseUrl) {
    return res.status(400).json({ error: 'base_url or at least one protocol URL is required' });
  }

  const existingName = await db.get('SELECT id FROM sources WHERE name = ?', [name]);
  if (existingName) {
    return res.status(400).json({ error: '源站名称已存在，请使用其他名称' });
  }

  if (stack_mode && !['merged', 'failover'].includes(stack_mode)) {
    return res.status(400).json({ error: 'stack_mode must be "merged" or "failover"' });
  }

  const encryptedKey = db.encrypt(api_key);

  // Build api_keys JSON: encrypt each protocol-specific key
  let encryptedApiKeys = null;
  if (api_keys && typeof api_keys === 'object') {
    const keys = {};
    for (const [proto, key] of Object.entries(api_keys)) {
      if (key) keys[proto] = db.encrypt(key);
    }
    encryptedApiKeys = JSON.stringify(keys);
  }

  // Build api_urls JSON
  let apiUrlsJson = null;
  if (api_urls && typeof api_urls === 'object') {
    const urls = {};
    for (const [proto, url] of Object.entries(api_urls)) {
      if (url) urls[proto] = url;
    }
    if (Object.keys(urls).length > 0) apiUrlsJson = JSON.stringify(urls);
  }

  const result = await db.run(
    `INSERT INTO sources (name, base_url, protocol, api_key, api_keys, api_urls, weight, max_concurrent, source_group, balance_group, stack_mode, quota_limit, strip_tools)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, effectiveBaseUrl, protocol || 'openai', encryptedKey, encryptedApiKeys, apiUrlsJson, weight || 1, max_concurrent || 1000000, source_group || null, balance_group || null, stack_mode || null, quota_limit !== undefined ? parseFloat(quota_limit) || 0 : 1000000, strip_tools ? true : false]
  );

  res.status(201).json({ id: result.lastInsertRowid, name, base_url: effectiveBaseUrl, protocol });
  adminEvents.broadcast('sources.changed', { type: 'created', id: result.lastInsertRowid });

  // P4 修复：新源站创建后立即触发一次探测，避免 UI 长期卡在"源站未检测"
  (async () => {
    try {
      const newSource = await db.get('SELECT * FROM sources WHERE id = ?', [result.lastInsertRowid]);
      if (!newSource || !newSource.is_active) return;
      const roundTimestamp = new Date().toISOString();
      await probeService.probeSource(newSource, roundTimestamp);
      await probeService.probeAndUpdate(newSource, roundTimestamp);
      adminEvents.broadcast('sources.changed', { type: 'probed', id: newSource.id, status: newSource.status });
    } catch (err) {
      console.error(`[Admin] Initial probe failed for new source ${result.lastInsertRowid}:`, err.message);
    }
  })();

  await invalidateAllSourceRouting();
});

router.put('/sources/:id', async (req, res) => {
  const { id } = req.params;
  const { name, base_url, protocol, api_key, api_keys, api_urls, weight, is_active, max_concurrent, source_group, stack_mode, quota_limit, quota_used, strip_tools } = req.body;
  const source = await db.get('SELECT * FROM sources WHERE id = ?', [parseInt(id)]);
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  if (name !== undefined && name !== source.name) {
    const existingName = await db.get('SELECT id FROM sources WHERE name = ? AND id != ?', [name, parseInt(id)]);
    if (existingName) {
      return res.status(400).json({ error: '源站名称已存在，请使用其他名称' });
    }
  }

  const encryptedKey = api_key ? db.encrypt(api_key) : undefined;
  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (base_url !== undefined) { fields.push('base_url = ?'); params.push(base_url); }
  if (protocol !== undefined) { fields.push('protocol = ?'); params.push(protocol); }
  if (encryptedKey !== undefined) { fields.push('api_key = ?'); params.push(encryptedKey); }
  if (weight !== undefined) { fields.push('weight = ?'); params.push(weight); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(max_concurrent); }
  if (source_group !== undefined) { fields.push('source_group = ?'); params.push(source_group || null); }
  if (stack_mode !== undefined) {
    if (stack_mode && !['merged', 'failover'].includes(stack_mode)) {
      return res.status(400).json({ error: 'stack_mode must be "merged" or "failover"' });
    }
    fields.push('stack_mode = ?'); params.push(stack_mode || null);
  }
  if (quota_limit !== undefined) {
    const ql = parseFloat(quota_limit);
    if (!isFinite(ql) || ql > 999999999999 || ql < 0) {
      return res.status(400).json({ error: { message: 'quota_limit out of range (max 999999999999.99999999)', type: 'invalid_request_error' } });
    }
    fields.push('quota_limit = ?'); params.push(ql);
  }
  if (quota_used !== undefined) {
    const qu = parseFloat(quota_used);
    if (!isFinite(qu) || qu > 999999999999 || qu < 0) {
      return res.status(400).json({ error: { message: 'quota_used out of range', type: 'invalid_request_error' } });
    }
    fields.push('quota_used = ?'); params.push(qu);
  }
  if (strip_tools !== undefined) { fields.push('strip_tools = ?'); params.push(strip_tools ? true : false); }

  // Handle api_keys update
  if (api_keys !== undefined && typeof api_keys === 'object') {
    const keys = {};
    for (const [proto, key] of Object.entries(api_keys)) {
      if (key) keys[proto] = db.encrypt(key);
    }
    let existingKeys = {};
    try { existingKeys = source.api_keys ? JSON.parse(source.api_keys) : {}; } catch (e) {}
    const merged = { ...existingKeys, ...keys };
    fields.push('api_keys = ?');
    params.push(JSON.stringify(merged));
  }

  // Handle api_urls update
  if (api_urls !== undefined && typeof api_urls === 'object') {
    const urls = {};
    for (const [proto, url] of Object.entries(api_urls)) {
      if (url) urls[proto] = url;
    }
    let oldUrls = {};
    if (source.api_urls) {
      oldUrls = typeof source.api_urls === 'object' ? source.api_urls : (() => { try { return JSON.parse(source.api_urls); } catch { return {}; } })();
    }
    const newUrls = urls;
    const urlChanged = JSON.stringify(oldUrls) !== JSON.stringify(newUrls);
    if (urlChanged) {
      await db.run('UPDATE models SET is_active = false WHERE source_id = ?', [parseInt(id)]);
    }
    fields.push('api_urls = ?');
    params.push(JSON.stringify(urls));
  }

  // Handle base_url update
  if (base_url !== undefined && base_url !== source.base_url) {
    await db.run('UPDATE models SET is_active = false WHERE source_id = ?', [parseInt(id)]);
  }

  if (fields.length === 0) {
    return res.json({ success: true, no_changes: true });
  }
  params.push(parseInt(id));
  await db.run(`UPDATE sources SET ${fields.join(', ')} WHERE id = ?`, params);

  if (!is_active && source.is_active) {
    await resetSourceConcurrent(parseInt(id));
  }
  await invalidateSourceRoutingCache(parseInt(id));

  res.json({ success: true });
  adminEvents.broadcast('sources.changed', { type: 'updated', id: parseInt(id) });
});

router.delete('/sources/:id', async (req, res) => {
  const { id } = req.params;
  
  // 标记模型为失效而不是删除
  await db.run('UPDATE models SET is_active = false WHERE source_id = ?', [parseInt(id)]);
  await db.run('DELETE FROM sources WHERE id = ?', [parseInt(id)]);

  await resetSourceConcurrent(parseInt(id));
  await invalidateAllSourceRouting();

  res.json({ success: true });
  adminEvents.broadcast('sources.changed', { type: 'deleted', id: parseInt(id) });
});

// 批量删除源站
router.post('/sources/batch-delete', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  for (const id of ids) {
    await db.run('UPDATE models SET is_active = false WHERE source_id = ?', [parseInt(id)]);
    await db.run('DELETE FROM sources WHERE id = ?', [parseInt(id)]);
    await resetSourceConcurrent(parseInt(id));
  }
  await invalidateAllSourceRouting();
  res.json({ success: true, deleted: ids.length });
  adminEvents.broadcast('sources.changed', { type: 'batch_deleted', ids });
});

// 批量更新源站（目前主要用于批量启用/禁用）
router.post('/sources/batch-update', async (req, res) => {
  const { ids, is_active } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  if (is_active === undefined) {
    return res.status(400).json({ error: 'is_active is required' });
  }
  const placeholders = ids.map(() => '?').join(',');
  await db.run(`UPDATE sources SET is_active = ? WHERE id IN (${placeholders})`, [is_active ? true : false, ...ids]);
  if (!is_active) {
    for (const id of ids) {
      await resetSourceConcurrent(parseInt(id));
    }
  }
  await invalidateAllSourceRouting();
  res.json({ success: true, updated: ids.length });
  adminEvents.broadcast('sources.changed', { type: 'batch_updated', ids, is_active });
});

// 批量初始化选中源站的路由检测
router.post('/sources/probe-selected', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  const sources = await db.all(`SELECT * FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const roundTimestamp = new Date().toISOString();
  const results = [];
  for (const source of sources) {
    try {
      await db.run(
        "UPDATE sources SET direct_status = 'enabled', direct_disabled_until = NULL, direct_fail_count = 0 WHERE id = ?",
        [source.id]
      );
      const probeResult = await probeService.probeSource(source, roundTimestamp);
      await probeService.probeAndUpdate(source, roundTimestamp);
      results.push({ sourceId: source.id, sourceName: source.name, success: true, probe: probeResult });
    } catch (err) {
      results.push({ sourceId: source.id, sourceName: source.name, success: false, error: err.message });
    }
  }
  for (const source of sources) {
    await invalidateSourceRoutingCache(source.id);
  }
  adminEvents.broadcast('sources.changed', { type: 'probed_selected', ids });
  res.json({ success: true, count: sources.length, results });
});

router.post('/sources/:id/test', async (req, res) => {
  const { id } = req.params;
  const result = await keyChecker.checkSource(parseInt(id));
  res.json(result);
  adminEvents.broadcast('sources.changed', { type: 'tested', id: parseInt(id), status: result?.status });
  await invalidateSourceRoutingCache(parseInt(id));
});

// 手动触发单个源站的路由检测/初始化
router.post('/sources/:id/probe', async (req, res) => {
  const { id } = req.params;
  const source = await db.get('SELECT * FROM sources WHERE id = ?', [parseInt(id)]);
  if (!source) {
    return res.status(404).json({ error: 'Source not found' });
  }

  // 重置路由禁用状态，让本次探测决定新的状态
  await db.run(
    "UPDATE sources SET direct_status = 'enabled', direct_disabled_until = NULL, direct_fail_count = 0 WHERE id = ?",
    [source.id]
  );

  const roundTimestamp = new Date().toISOString();
  const probeResult = await probeService.probeSource(source, roundTimestamp);
  await probeService.probeAndUpdate(source, roundTimestamp);

  res.json({ success: true, sourceId: source.id, sourceName: source.name, probe: probeResult });
  adminEvents.broadcast('sources.changed', { type: 'probed', id: source.id });
  await invalidateSourceRoutingCache(source.id);
});

// 手动触发全部活跃源站的路由检测/初始化（并发执行，默认 5 个并行）
router.post('/sources/probe-all', async (req, res) => {
  const sources = await db.all("SELECT * FROM sources WHERE is_active = true");
  const roundTimestamp = new Date().toISOString();
  const results = [];
  const concurrency = Math.max(1, Math.min(10, parseInt(req.query.concurrency, 10) || 5));

  async function resetAndProbe(source) {
    try {
      await db.run(
        "UPDATE sources SET direct_status = 'enabled', direct_disabled_until = NULL, direct_fail_count = 0 WHERE id = ?",
        [source.id]
      );
      const probeResult = await probeService.probeSource(source, roundTimestamp);
      await probeService.probeAndUpdate(source, roundTimestamp);
      results.push({ sourceId: source.id, sourceName: source.name, success: true, probe: probeResult });
    } catch (err) {
      results.push({ sourceId: source.id, sourceName: source.name, success: false, error: err.message });
    }
  }

  let index = 0;
  async function worker() {
    while (index < sources.length) {
      const source = sources[index++];
      await resetAndProbe(source);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  adminEvents.broadcast('sources.changed', { type: 'probed_all' });
  await invalidateAllSourceRouting();
  res.json({ success: true, count: sources.length, results });
});

// Helper: generate unique model_id with auto-suffix for cross-source conflicts
async function generateUniqueModelId(baseModelId, excludeSourceId) {
  const existing = await db.all(
    'SELECT model_id FROM models WHERE model_id = ? OR model_id LIKE ?',
    [baseModelId, baseModelId + '_%']
  );

  if (existing.length === 0) return baseModelId;

  // Check if base model_id exists from another source
  const baseExists = existing.some(m => m.model_id === baseModelId);
  if (!baseExists) return baseModelId;

  // Find the max suffix number
  let maxSuffix = 1;
  for (const m of existing) {
    if (m.model_id === baseModelId) {
      maxSuffix = Math.max(maxSuffix, 1);
    } else if (m.model_id.startsWith(baseModelId + '_')) {
      const num = parseInt(m.model_id.substring(baseModelId.length + 1));
      if (!isNaN(num)) maxSuffix = Math.max(maxSuffix, num);
    }
  }

  return `${baseModelId}_${maxSuffix + 1}`;
}

// Helper: re-index model suffixes after deletion to fill gaps
async function reindexModelSuffixes(baseModelId) {
  const all = await db.all(
    'SELECT id, model_id FROM models WHERE model_id = ? OR model_id LIKE ? ORDER BY model_id',
    [baseModelId, baseModelId + '_%']
  );

  if (all.length <= 1) return;

  let index = 1;
  for (const m of all) {
    const expectedId = index === 1 ? baseModelId : `${baseModelId}_${index}`;
    if (m.model_id !== expectedId) {
      await db.run('UPDATE models SET model_id = ? WHERE id = ?', [expectedId, m.id]);
    }
    index++;
  }
}

// Step 1: Detect models from source (no import)
router.post('/sources/:id/detect-models', async (req, res) => {
  const { id } = req.params;
  const result = await keyChecker.fetchModels(parseInt(id));

  if (result && result.success && result.models) {
    const existingModels = await db.all('SELECT model_id, source_model_id FROM models WHERE source_id = ?', [parseInt(id)]);
    const existingSet = new Set(existingModels.map(m => m.source_model_id || m.model_id));

    result.models = result.models.map(m => ({
      ...m,
      already_exists: existingSet.has(m.id)
    }));
    result.existing_count = existingModels.length;
  }

  res.json(result);
});

// Step 2: Import selected models
router.post('/sources/:id/import-models', async (req, res) => {
  const { id } = req.params;
  const { model_ids, default_input_price, default_input_price_cache, default_output_price, default_group, default_groups } = req.body;

  if (!model_ids || !Array.isArray(model_ids) || model_ids.length === 0) {
    return res.status(400).json({ error: 'model_ids array is required' });
  }

  const inputPrice = default_input_price !== undefined ? parseFloat(default_input_price) : 0.025;
  const inputPriceCache = default_input_price_cache !== undefined ? parseFloat(default_input_price_cache) : 0.02;
  const outputPrice = default_output_price !== undefined ? parseFloat(default_output_price) : 2;
  const group = (Array.isArray(default_groups) && default_groups.length > 0) ? JSON.stringify(default_groups) : (default_group ? JSON.stringify([default_group]) : '["default"]');

  let imported = 0;
  const skipped = [];

  for (const modelId of model_ids) {
    const existingSameSource = await db.get('SELECT id FROM models WHERE source_id = ? AND source_model_id = ?', [parseInt(id), modelId]);
    if (existingSameSource) {
      skipped.push({ id: modelId, reason: '源站已存在' });
      continue;
    }

    const uniqueId = await generateUniqueModelId(modelId, parseInt(id));

    await db.run(
      `INSERT INTO models (source_id, model_id, source_model_id, model_alias, input_price, input_price_cache, output_price, model_group, max_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [parseInt(id), uniqueId, modelId, modelId, inputPrice, inputPriceCache, outputPrice, group, 4096]
    );
    imported++;

    if (uniqueId !== modelId) {
      skipped.push({ id: modelId, stored_as: uniqueId, reason: '自动重命名(跨源站冲突)' });
    }
  }

  res.json({ success: true, imported, skipped, total: model_ids.length });
  adminEvents.broadcast('models.changed', { type: 'imported', sourceId: parseInt(id), imported });
  await invalidateModelRelatedCache();
});

router.get('/sources/concurrency', async (req, res) => {
  try {
    const status = await dispatcher.getConcurrencyStatus();
    res.json(status);
  } catch (err) {
    console.error('[admin] /sources/concurrency error:', err.message);
    res.status(503).json({ error: 'Service temporarily unavailable', message: err.message });
  }
});

/**
 * @swagger
 * /admin/models:
 *   get:
 *     summary: List all models
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of models
 */
router.get('/models', async (req, res) => {
  const models = await db.all(`
    SELECT m.*, s.name as source_name, s.protocol, s.status as source_status, s.source_group,
           s.stack_mode, s.is_active as source_is_active, s.quota_limit, s.quota_used,
           s.last_check_at, s.last_check_status_code, s.last_check_detail,
           s.direct_status, s.direct_disabled_until
    FROM models m
    JOIN sources s ON m.source_id = s.id
    ORDER BY m.model_group, m.priority DESC, m.model_id
  `);

  const instances = await db.all('SELECT * FROM instances ORDER BY created_at DESC');
  const instanceMembers = await db.all(`
    SELECT im.*, s.name as source_name, s.status as source_status, s.is_active as source_is_active,
           s.quota_limit, s.quota_used, s.direct_status, s.direct_disabled_until
    FROM instance_members im
    JOIN sources s ON im.source_id = s.id
  `);

  const result = models.map(model => {
    const sourceInfo = {
      id: model.source_id,
      name: model.source_name,
      protocol: model.protocol,
      status: model.source_status,
      source_group: model.source_group,
      stack_mode: model.stack_mode,
      is_active: model.source_is_active,
      quota_limit: model.quota_limit,
      quota_used: model.quota_used,
      last_check_at: model.last_check_at,
      last_check_status_code: model.last_check_status_code,
      last_check_detail: model.last_check_detail,
      direct_status: model.direct_status,
      direct_disabled_until: model.direct_disabled_until
    };
    const computed = computeModelRoutingStatus(model, sourceInfo, instances, instanceMembers);
    return {
      ...model,
      routing_status: computed.routing_status,
      balance_status: computed.balance_status,
      effective_source_status: computed.effective_source_status
    };
  });

  res.json(result);
});

/**
 * @swagger
 * /admin/models/health:
 *   get:
 *     summary: Get health metrics for all models
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Model health data keyed by model_id
 */
router.get('/models/health', async (req, res) => {
  const models = await db.all('SELECT model_id FROM models WHERE is_active = true');
  const modelIds = models.map(m => m.model_id);
  if (modelIds.length === 0) return res.json({});

  // Build placeholders for IN clause
  const placeholders = modelIds.map(() => '?').join(',');
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  // Cap samples to avoid scanning the whole table when no recent records exist.
  const rows = await db.all(
    `SELECT model, latency_ms FROM request_logs
     WHERE model IN (${placeholders})
       AND created_at > ?
       AND latency_ms IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1000`,
    [...modelIds, fiveMinutesAgo]
  );

  const health = {};
  for (const row of rows) {
    if (!health[row.model]) health[row.model] = [];
    health[row.model].push(row.latency_ms);
  }

  const result = {};
  for (const [modelId, latencies] of Object.entries(health)) {
    const sparkline = latencies.slice(0, 20).reverse(); // last 20, oldest first
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    result[modelId] = {
      sparkline,
      avgLatency: Math.round(avg),
      healthy: true
    };
  }

  res.json(result);
});

// 不消耗 Token 的模型存在性验证
router.post('/models/:id/validate', async (req, res) => {
  const { id } = req.params;
  const model = await db.get(
    `SELECT m.*, s.name as source_name, s.protocol, s.api_key, s.api_keys, s.api_urls, s.base_url,
            s.status as source_status, s.is_active as source_is_active, s.direct_status, s.direct_disabled_until
     FROM models m
     JOIN sources s ON m.source_id = s.id
     WHERE m.id = ?`,
    [parseInt(id)]
  );
  if (!model) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const protocol = req.body.protocol || req.query.protocol || model.protocol || 'openai';
  const source = { ...model, protocol };
  const checkId = model.source_model_id || model.model_id;
  const checkResult = await keyChecker.validateModelExists(source, checkId);

  res.json({
    ...checkResult,
    sourceName: model.source_name,
    protocol,
    modelId: checkId,
    checkedAt: new Date().toISOString()
  });
});

// 按模型测试 Key：使用模型对应的源站及 source_model_id 发起一次最小化调用
router.post('/models/:id/test-key', async (req, res) => {
  const { id } = req.params;
  const model = await db.get(
    `SELECT m.*, s.name as source_name FROM models m JOIN sources s ON m.source_id = s.id WHERE m.id = ?`,
    [parseInt(id)]
  );
  if (!model) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const testModelId = model.source_model_id || model.model_id;
  const result = await keyChecker.checkSource(model.source_id, testModelId);

  res.json({
    ...result,
    sourceName: model.source_name,
    modelId: testModelId,
    checkedAt: new Date().toISOString()
  });
  adminEvents.broadcast('sources.changed', { type: 'tested', id: model.source_id, status: result?.status });
  await invalidateSourceRoutingCache(model.source_id);
});

router.post('/models', async (req, res) => {
  const { source_id, model_id, model_alias, input_price, input_price_cache, output_price,
          max_tokens, is_vision, is_active, priority, description, supports_tools, supports_json, supports_fim, model_group } = req.body;

  if (!source_id || !model_id) {
    return res.status(400).json({ error: 'source_id and model_id are required' });
  }

  const defaults = await getUserDefaults();

  // Auto-suffix if model_id conflicts with another source
  const uniqueId = await generateUniqueModelId(model_id, parseInt(source_id));
  const groupStr = Array.isArray(model_group) ? JSON.stringify(model_group) : (model_group || '["default"]');

  const result = await db.run(
    `INSERT INTO models (source_id, model_id, source_model_id, model_alias, input_price, input_price_cache, output_price,
                         max_tokens, is_vision, is_active, priority, description, supports_tools, supports_json, supports_fim, model_group, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [source_id, uniqueId, req.body.source_model_id || model_id, model_alias || model_id,
     input_price !== undefined ? input_price : 0.025,
     input_price_cache !== undefined ? input_price_cache : 0.02,
     output_price !== undefined ? output_price : 2,
     max_tokens || 4096, is_vision || 0, is_active ?? 1, priority || 0, description || null,
     supports_tools ?? 1, supports_json ?? 1, supports_fim ?? 0, groupStr,
     defaults.max_concurrent]
  );

  res.status(201).json({ id: result.lastInsertRowid, model_id: uniqueId, renamed: uniqueId !== model_id });
  adminEvents.broadcast('models.changed', { type: 'created', id: result.lastInsertRowid });
  await invalidateModelRelatedCache();
});

router.put('/models/:id', async (req, res) => {
  const { id } = req.params;
  const { model_id, source_model_id, model_alias, input_price, input_price_cache, output_price, completion_price,
          max_tokens, is_vision, is_active, priority, description, model_group, rate_multiplier,
          supports_tools, supports_json, supports_fim, max_concurrent } = req.body;

  const fields = [];
  const params = [];
  if (model_id !== undefined) { fields.push('model_id = ?'); params.push(model_id); }
  if (source_model_id !== undefined) { fields.push('source_model_id = ?'); params.push(source_model_id); }
  if (model_alias !== undefined) { fields.push('model_alias = ?'); params.push(model_alias); }
  if (input_price !== undefined) { fields.push('input_price = ?'); params.push(input_price); }
  if (input_price_cache !== undefined) { fields.push('input_price_cache = ?'); params.push(input_price_cache); }
  if (output_price !== undefined) { fields.push('output_price = ?'); params.push(output_price); }
  if (completion_price !== undefined) { fields.push('completion_price = ?'); params.push(completion_price); }
  if (max_tokens !== undefined) { fields.push('max_tokens = ?'); params.push(max_tokens); }
  if (is_vision !== undefined) { fields.push('is_vision = ?'); params.push(asBool(is_vision, false)); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (model_group !== undefined) { fields.push('model_group = ?'); params.push(Array.isArray(model_group) ? JSON.stringify(model_group) : model_group); }
  if (rate_multiplier !== undefined) { fields.push('rate_multiplier = ?'); params.push(rate_multiplier); }
  if (supports_tools !== undefined) { fields.push('supports_tools = ?'); params.push(asBool(supports_tools, false)); }
  if (supports_json !== undefined) { fields.push('supports_json = ?'); params.push(asBool(supports_json, false)); }
  if (supports_fim !== undefined) { fields.push('supports_fim = ?'); params.push(asBool(supports_fim, false)); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent) || 100); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true, received: req.body });
  params.push(parseInt(id));
  await db.run(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`, params);

  res.json({ success: true });
  adminEvents.broadcast('models.changed', { type: 'updated', id: parseInt(id) });
  await invalidateModelRelatedCache();
});

router.post('/models/batch-update', async (req, res) => {
  const { ids, input_price, input_price_cache, output_price, completion_price,
          model_group, rate_multiplier, is_active, supports_tools, supports_json, supports_fim, max_concurrent } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const fields = [];
  const params = [];
  if (input_price !== undefined) { fields.push('input_price = ?'); params.push(input_price); }
  if (input_price_cache !== undefined) { fields.push('input_price_cache = ?'); params.push(input_price_cache); }
  if (output_price !== undefined) { fields.push('output_price = ?'); params.push(output_price); }
  if (completion_price !== undefined) { fields.push('completion_price = ?'); params.push(completion_price); }
  if (model_group !== undefined) { fields.push('model_group = ?'); params.push(Array.isArray(model_group) ? JSON.stringify(model_group) : model_group); }
  if (rate_multiplier !== undefined) { fields.push('rate_multiplier = ?'); params.push(rate_multiplier); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (supports_tools !== undefined) { fields.push('supports_tools = ?'); params.push(asBool(supports_tools, false)); }
  if (supports_json !== undefined) { fields.push('supports_json = ?'); params.push(asBool(supports_json, false)); }
  if (supports_fim !== undefined) { fields.push('supports_fim = ?'); params.push(asBool(supports_fim, false)); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent) || 100); }

  if (fields.length === 0) return res.json({ success: true, no_changes: true, received: req.body });

  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE models SET ${fields.join(', ')} WHERE id IN (${placeholders})`;
  await db.run(sql, [...params, ...ids.map(Number)]);

  res.json({ success: true, updated: ids.length });
  adminEvents.broadcast('models.changed', { type: 'batch_updated', ids });
  await invalidateModelRelatedCache();
});

// ========== Model Groups ==========
router.get('/model-groups', async (req, res) => {
  const groups = await db.all('SELECT * FROM model_groups ORDER BY created_at DESC');
  res.json(groups);
});

router.post('/model-groups', async (req, res) => {
  const { name, description, rate_multiplier } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const existing = await db.get('SELECT id FROM model_groups WHERE name = ?', [name]);
  if (existing) {
    return res.status(400).json({ error: 'Group name already exists' });
  }

  const result = await db.run(
    `INSERT INTO model_groups (name, description, rate_multiplier) VALUES (?, ?, ?)`,
    [name, description || null, rate_multiplier || 1]
  );

  res.status(201).json({ id: result.lastInsertRowid, name });
  adminEvents.broadcast('model-groups.changed', { type: 'created', id: result.lastInsertRowid });
  await invalidateModelRelatedCache();
});

router.put('/model-groups/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description, rate_multiplier, is_active } = req.body;

  const group = await db.get('SELECT * FROM model_groups WHERE id = ?', [parseInt(id)]);
  if (!group) return res.status(404).json({ error: 'Group not found' });

  const fields = [];
  const params = [];

  if (name !== undefined && name !== group.name) {
    const existing = await db.get('SELECT id FROM model_groups WHERE name = ? AND id != ?', [name, parseInt(id)]);
    if (existing) return res.status(400).json({ error: 'Group name already exists' });
    fields.push('name = ?');
    params.push(name);
  }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (rate_multiplier !== undefined) { fields.push('rate_multiplier = ?'); params.push(rate_multiplier); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });
  params.push(parseInt(id));
  await db.run(`UPDATE model_groups SET ${fields.join(', ')} WHERE id = ?`, params);

  // 如果重命名了 default 分组，同步更新所有 models 中引用旧名称的 model_group
  if (name !== undefined && name !== group.name && group.name === 'default') {
    const allModels = await db.all('SELECT id, model_group FROM models');
    for (const m of allModels) {
      const groups = JSON.parse(m.model_group || '["default"]');
      const idx = groups.indexOf(group.name);
      if (idx !== -1) {
        groups[idx] = name;
        await db.run('UPDATE models SET model_group = ? WHERE id = ?', [JSON.stringify(groups), m.id]);
      }
    }
  }

  res.json({ success: true });
  adminEvents.broadcast('model-groups.changed', { type: 'updated', id: parseInt(id) });
  await invalidateModelRelatedCache();
});

router.delete('/model-groups/:id', async (req, res) => {
  const { id } = req.params;
  const group = await db.get('SELECT * FROM model_groups WHERE id = ?', [parseInt(id)]);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  if (group.is_system) return res.status(400).json({ error: '系统分组不可删除' });
  await db.run('DELETE FROM model_groups WHERE id = ?', [parseInt(id)]);
  res.json({ success: true });
  adminEvents.broadcast('model-groups.changed', { type: 'deleted', id: parseInt(id) });
  await invalidateModelRelatedCache();
});

router.delete('/models/:id', async (req, res) => {
  const model = await db.get('SELECT model_id, instance_id FROM models WHERE id = ?', [parseInt(req.params.id)]);
  if (!model) return res.status(404).json({ error: 'Model not found' });
  if (model.instance_id) {
    return res.status(400).json({ error: '该模型由实例管理绑定，请在均衡管理中移除实例后自动删除' });
  }

  await db.run('DELETE FROM models WHERE id = ?', [parseInt(req.params.id)]);

  // Extract base model_id (without suffix) and reindex remaining models
  const baseModelId = model.model_id.replace(/_\d+$/, '');
  reindexModelSuffixes(baseModelId);

  res.json({ success: true });
  adminEvents.broadcast('models.changed', { type: 'deleted', id: parseInt(req.params.id) });
});

router.post('/models/batch-delete', async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array is required' });
    }

    const numericIds = ids.map(Number).filter(n => !isNaN(n));
    if (numericIds.length === 0) {
      return res.status(400).json({ error: 'No valid IDs provided' });
    }

    // Get model_ids before deletion for reindexing
    const placeholders = numericIds.map(() => '?').join(',');
    const modelsToDelete = await db.all(`SELECT model_id FROM models WHERE id IN (${placeholders})`, numericIds);

    await db.run(`DELETE FROM models WHERE id IN (${placeholders})`, numericIds);

    // Reindex affected base model_ids
    const baseModelIds = [...new Set(modelsToDelete.map(m => m.model_id.replace(/_\d+$/, '')))];
    for (const baseModelId of baseModelIds) {
      reindexModelSuffixes(baseModelId);
    }

    res.json({ success: true, deleted: numericIds.length });
    adminEvents.broadcast('models.changed', { type: 'batch_deleted', ids: numericIds });
    await invalidateModelRelatedCache();
  } catch (error) {
    console.error('Batch delete error:', error);
    res.status(500).json({ error: error?.message });
  }
});

const { getRegistrationConfig, setRegistrationConfig } = require('../services/registration-config');
const { getMailConfig, setMailConfig } = require('../services/mail-config');
const mailSender = require('../services/mail-sender');

/**
 * @swagger
 * /admin/registration/config:
 *   get:
 *     summary: Get registration configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Registration configuration
 */
router.get('/registration/config', async (req, res) => {
  try {
    const config = await getRegistrationConfig();
    res.json(config);
  } catch (err) {
    console.error('[Admin] Failed to read registration config:', err.message);
    res.status(500).json({ error: '读取注册配置失败' });
  }
});

/**
 * @swagger
 * /admin/registration/config:
 *   put:
 *     summary: Update registration configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               registrationEnabled: { type: boolean }
 *               captchaEnabled: { type: boolean }
 *               approvalMode: { type: string, enum: ['auto', 'manual'] }
 *     responses:
 *       200:
 *         description: Config updated
 */
router.put('/registration/config', async (req, res) => {
  try {
    await setRegistrationConfig(req.body);
    const config = await getRegistrationConfig();
    res.json({ success: true, config });
  } catch (err) {
    console.error('[Admin] Failed to save registration config:', err.message);
    res.status(500).json({ error: '保存注册配置失败' });
  }
});

/**
 * @swagger
 * /admin/registration/pending:
 *   get:
 *     summary: List pending registration approvals
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Pending users
 */
router.get('/registration/pending', async (req, res) => {
  try {
    const users = await db.all(`
      SELECT id, username, role, balance, quota_limit, quota_used, is_active, currency,
             tpm, rpm, tpd, max_concurrent, created_at
      FROM users WHERE role = 'user' AND is_active = false
      ORDER BY created_at DESC
    `);
    res.json(users);
  } catch (err) {
    console.error('[Admin] Failed to list pending users:', err.message);
    res.status(500).json({ error: '读取待审批用户失败' });
  }
});

/**
 * @swagger
 * /admin/registration/{id}/approve:
 *   post:
 *     summary: Approve a pending user registration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.post('/registration/:id/approve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }
    const user = await db.get('SELECT id, username, is_active FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    await db.run('UPDATE users SET is_active = true WHERE id = ?', [id]);
    adminEvents.broadcast('users.changed', { type: 'approved', id });
    res.json({ success: true, message: '已批准' });
  } catch (err) {
    console.error('[Admin] Failed to approve user:', err.message);
    res.status(500).json({ error: '审批失败' });
  }
});

/**
 * @swagger
 * /admin/registration/{id}/reject:
 *   post:
 *     summary: Reject a pending user registration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 */
router.post('/registration/:id/reject', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      return res.status(400).json({ error: '无效的用户 ID' });
    }
    const user = await db.get('SELECT id, username, is_active FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    await db.run('DELETE FROM users WHERE id = ?', [id]);
    adminEvents.broadcast('users.changed', { type: 'rejected', id });
    res.json({ success: true, message: '已拒绝' });
  } catch (err) {
    console.error('[Admin] Failed to reject user:', err.message);
    res.status(500).json({ error: '拒绝失败' });
  }
});

/**
 * @swagger
 * /admin/mail/config:
 *   get:
 *     summary: Get SMTP mail configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: SMTP configuration
 */
router.get('/mail/config', async (req, res) => {
  try {
    const config = await getMailConfig();
    res.json({ ...config, pass: config.pass ? '********' : '' });
  } catch (err) {
    console.error('[Admin] Failed to read mail config:', err.message);
    res.status(500).json({ error: '读取邮件配置失败' });
  }
});

/**
 * @swagger
 * /admin/mail/config:
 *   put:
 *     summary: Update SMTP mail configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               host: { type: string }
 *               port: { type: integer }
 *               secure: { type: boolean }
 *               user: { type: string }
 *               pass: { type: string }
 *               from: { type: string }
 *     responses:
 *       200:
 *         description: Config updated
 */
router.put('/mail/config', async (req, res) => {
  try {
    const { host, port, secure, user, pass, from } = req.body;
    await setMailConfig({ host, port, secure, user, pass, from });
    mailSender.clearCache();
    const config = await getMailConfig();
    res.json({ success: true, config: { ...config, pass: config.pass ? '********' : '' } });
  } catch (err) {
    console.error('[Admin] Failed to save mail config:', err.message);
    res.status(500).json({ error: '保存邮件配置失败' });
  }
});

/**
 * @swagger
 * /admin/mail/test:
 *   post:
 *     summary: Send a test email to verify SMTP settings
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               to: { type: string, format: email }
 *     responses:
 *       200:
 *         description: Test email sent
 */
router.post('/mail/test', async (req, res) => {
  try {
    const { to } = req.body;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      return res.status(400).json({ error: '请输入有效的邮箱地址' });
    }
    const config = await getMailConfig();
    if (!config.from) {
      return res.status(400).json({ error: '发件人未配置' });
    }
    await mailSender.sendVerificationCode(to, '000000');
    res.json({ success: true, message: '测试邮件已发送' });
  } catch (err) {
    console.error('[Admin] Failed to send test mail:', err.message);
    res.status(500).json({ error: err.message || '测试邮件发送失败' });
  }
});

/**
 * @swagger
 * /admin/users:
 *   get:
 *     summary: List all users
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of users
 */
router.get('/users', async (req, res) => {
  const users = await db.all(`
    SELECT id, username, role, balance, quota_limit, quota_used, is_active, currency,
           tpm, rpm, tpd, max_concurrent, created_at
    FROM users ORDER BY created_at DESC
  `);
  res.json(users);
});

router.post('/users', async (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  const policy = validatePassword(password);
  if (!policy.valid) {
    return res.status(400).json({ error: policy.error });
  }

  const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    return res.status(400).json({ error: 'Username already exists' });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const defaults = await getUserDefaults();

  const result = await db.run(
    `INSERT INTO users (username, password_hash, role, tpm, rpm, tpd, max_concurrent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      username,
      passwordHash,
      role || 'user',
      defaults.tpm ?? 10000000,
      defaults.rpm ?? 100,
      1000000000,
      defaults.max_concurrent ?? 100
    ]
  );

  res.status(201).json({ id: result.lastInsertRowid, username, role });
  adminEvents.broadcast('users.changed', { type: 'created', id: result.lastInsertRowid });
});

/**
 * @swagger
 * /admin/users/defaults:
 *   get:
 *     summary: Get default configuration for new users/keys
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Default user config
 */
router.get('/users/defaults', async (req, res) => {
  const row = await db.get('SELECT * FROM user_defaults ORDER BY id LIMIT 1');
  if (!row) {
    return res.json({
      tpm: 10000000,
      rpm: 100,
      tpd: 1000000000,
      max_concurrent: 100
    });
  }
  res.json(row);
});

/**
 * @swagger
 * /admin/users/defaults:
 *   put:
 *     summary: Update default configuration for new users/keys
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               tpm: { type: integer }
 *               rpm: { type: integer }
 *               tpd: { type: integer }
 *               max_concurrent: { type: integer }
 *     responses:
 *       200:
 *         description: Updated defaults
 */
router.put('/users/defaults', async (req, res) => {
  const { tpm, rpm, tpd, max_concurrent } = req.body;
  const fields = [];
  const params = [];
  if (tpm !== undefined) { fields.push('tpm = ?'); params.push(parseInt(tpm) || 0); }
  if (rpm !== undefined) { fields.push('rpm = ?'); params.push(parseInt(rpm) || 0); }
  if (tpd !== undefined) { fields.push('tpd = ?'); params.push(parseInt(tpd) || 0); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent) || 100); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });

  const row = await db.get('SELECT id FROM user_defaults ORDER BY id LIMIT 1');
  if (row) {
    params.push(row.id);
    await db.run(`UPDATE user_defaults SET ${fields.join(', ')} WHERE id = ?`, params);
  } else {
    await db.run(
      `INSERT INTO user_defaults (tpm, rpm, tpd, max_concurrent, updated_at) VALUES (?, ?, ?, ?, NOW())`,
      [
        tpm !== undefined ? parseInt(tpm) || 0 : 10000000,
        rpm !== undefined ? parseInt(rpm) || 0 : 100,
        tpd !== undefined ? parseInt(tpd) || 0 : 10000000,
        max_concurrent !== undefined ? parseInt(max_concurrent) || 100 : 100
      ]
    );
  }
  _userDefaultsCache = null;
  res.json({ success: true });
});

router.put('/users/:id', async (req, res) => {
  const { id } = req.params;
  const { is_active, username, password, role, tpm, rpm, tpd, max_concurrent } = req.body;
  if (process.env.LOG_LEVEL === 'debug') console.log(`[PUT /users/${id}] body:`, JSON.stringify(req.body));

  const fields = [];
  const params = [];
  if (username !== undefined) { fields.push('username = ?'); params.push(username); }
  if (password !== undefined) {
    const policy = validatePassword(password);
    if (!policy.valid) {
      return res.status(400).json({ error: policy.error });
    }
    fields.push('password_hash = ?');
    params.push(bcrypt.hashSync(password, 10));
  }
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  const newIsActive = is_active !== undefined ? asBool(is_active, false) : undefined;
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(newIsActive); }
  if (tpm !== undefined) { fields.push('tpm = ?'); params.push(parseInt(tpm) || 0); }
  if (rpm !== undefined) { fields.push('rpm = ?'); params.push(parseInt(rpm) || 0); }
  if (tpd !== undefined) { fields.push('tpd = ?'); params.push(parseInt(tpd) || 0); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(parseInt(max_concurrent) || 0); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });
  params.push(parseInt(id));
  const sql = `UPDATE users SET ${fields.join(', ')} WHERE id = ?`;
  if (process.env.LOG_LEVEL === 'debug') console.log(`[PUT /users/${id}] sql:`, sql, 'params:', params);
  await db.run(sql, params);

  // Revoke existing tokens when password changes or account is disabled
  if (password !== undefined || newIsActive === false) {
    await revokeAllUserTokens(parseInt(id));
  }

  res.json({ success: true });
  adminEvents.broadcast('users.changed', { type: 'updated', id: parseInt(id) });
});

router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  
  if (parseInt(id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete yourself' });
  }

  await db.run('DELETE FROM user_keys WHERE user_id = ?', [parseInt(id)]);
  await db.run('DELETE FROM users WHERE id = ?', [parseInt(id)]);
  apiKeyMiddleware.invalidateCache();
  
  res.json({ success: true });
  adminEvents.broadcast('users.changed', { type: 'deleted', id: parseInt(id) });
});

router.get('/users/:id/keys', async (req, res) => {
  const keys = await db.all(`
    SELECT k.id, k.key_prefix, k.encrypted_key, k.name, k.is_active, k.max_concurrent, k.current_concurrent,
           k.total_requests, k.total_tokens, k.rate_limit, k.last_used_at, k.created_at,
           k.model_limit, k.group_limit, k.expires_at, k.quota_limit, k.quota_used, k.currency, k.quota_type, k.workspace_id,
           w.name as workspace_name
    FROM user_keys k
    LEFT JOIN workspaces w ON k.workspace_id = w.id
    WHERE k.user_id = ?
    ORDER BY k.created_at DESC
  `, [parseInt(req.params.id)]);

  const result = keys.map(k => ({
    ...k,
    key: k.encrypted_key ? db.decrypt(k.encrypted_key) : null
  }));

  res.json(result);
});

router.post('/users/:id/keys', async (req, res) => {
  const { name, max_concurrent, rate_limit, model_limit, group_limit, expires_at, quota_limit, currency, quota_type, workspace_id } = req.body;
  const defaults = await getUserDefaults();
  const rawKey = `sk-${uuidv4().replace(/-/g, '').substring(0, 32)}`;
  const keyHash = bcrypt.hashSync(rawKey, 10);
  const keyPrefix = rawKey.substring(0, 12) + '...';
  const encryptedKey = db.encrypt(rawKey);

  const result = await db.run(
    `INSERT INTO user_keys (user_id, key_hash, key_prefix, encrypted_key, name, max_concurrent, rate_limit,
     model_limit, group_limit, expires_at, quota_limit, currency, quota_type, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      parseInt(req.params.id), keyHash, keyPrefix, encryptedKey, name || 'API Key',
      max_concurrent ?? defaults.max_concurrent, rate_limit || 60,
      model_limit || 'all', group_limit || 'all',
      expires_at || null, quota_limit || 0,
      currency || 'CNY', quota_type || 'tokens',
      workspace_id || null
    ]
  );

  apiKeyMiddleware.invalidateCache();

  res.status(201).json({
    id: result.lastInsertRowid,
    key: rawKey,
    key_prefix: keyPrefix,
    name: name || 'API Key'
  });
  adminEvents.broadcast('keys.changed', { type: 'created', userId: parseInt(req.params.id), id: result.lastInsertRowid });
});

router.put('/keys/:keyId', async (req, res) => {
  const { keyId } = req.params;
  const { name, is_active, max_concurrent, rate_limit, model_limit, group_limit, expires_at, quota_limit, currency, quota_type, workspace_id } = req.body;

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (max_concurrent !== undefined) { fields.push('max_concurrent = ?'); params.push(max_concurrent); }
  if (rate_limit !== undefined) { fields.push('rate_limit = ?'); params.push(rate_limit); }
  if (model_limit !== undefined) { fields.push('model_limit = ?'); params.push(model_limit); }
  if (group_limit !== undefined) { fields.push('group_limit = ?'); params.push(group_limit); }
  if (expires_at !== undefined) { fields.push('expires_at = ?'); params.push(expires_at); }
  if (quota_limit !== undefined) {
    const ql = parseFloat(quota_limit);
    if (!isFinite(ql) || ql > 999999999999 || ql < 0) {
      return res.status(400).json({ error: { message: 'quota_limit out of range (max 999999999999.99999999)', type: 'invalid_request_error' } });
    }
    fields.push('quota_limit = ?'); params.push(ql);
  }
  if (currency !== undefined) { fields.push('currency = ?'); params.push(currency); }
  if (quota_type !== undefined) { fields.push('quota_type = ?'); params.push(quota_type); }
  if (workspace_id !== undefined) { fields.push('workspace_id = ?'); params.push(workspace_id || null); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });
  params.push(parseInt(keyId));
  await db.run(`UPDATE user_keys SET ${fields.join(', ')} WHERE id = ?`, params);
  apiKeyMiddleware.invalidateCache();

  res.json({ success: true });
  adminEvents.broadcast('keys.changed', { type: 'updated', id: parseInt(keyId) });
});

router.delete('/keys/:keyId', async (req, res) => {
  await db.run('DELETE FROM user_keys WHERE id = ?', [parseInt(req.params.keyId)]);
  apiKeyMiddleware.invalidateCache();
  res.json({ success: true });
  adminEvents.broadcast('keys.changed', { type: 'deleted', id: parseInt(req.params.keyId) });
});

// Admin workspace key management
router.get('/workspaces/:id/keys', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
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

router.post('/workspaces/:id/keys', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { name, max_concurrent, rate_limit, model_limit, group_limit, expires_at, quota_limit, currency, quota_type } = req.body;

  const workspace = await db.get('SELECT id, owner_id FROM workspaces WHERE id = ? AND status = ?', [workspaceId, 'active']);
  if (!workspace) {
    return res.status(404).json({ error: '工作空间不存在' });
  }

  const defaults = await getUserDefaults();
  const rawKey = `sk-${uuidv4().replace(/-/g, '').substring(0, 32)}`;
  const keyHash = bcrypt.hashSync(rawKey, 10);
  const keyPrefix = rawKey.substring(0, 12) + '...';
  const encryptedKey = db.encrypt(rawKey);

  const result = await db.run(
    `INSERT INTO user_keys (user_id, key_hash, key_prefix, encrypted_key, name, max_concurrent, rate_limit,
     model_limit, group_limit, expires_at, quota_limit, currency, quota_type, workspace_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workspace.owner_id, keyHash, keyPrefix, encryptedKey, name || 'Workspace API Key',
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

router.delete('/workspaces/:id/keys/:keyId', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const keyId = parseInt(req.params.keyId);

  const key = await db.get('SELECT id FROM user_keys WHERE id = ? AND workspace_id = ?', [keyId, workspaceId]);
  if (!key) {
    return res.status(404).json({ error: 'API Key 不存在' });
  }

  await db.run('DELETE FROM user_keys WHERE id = ?', [keyId]);
  apiKeyMiddleware.invalidateCache();
  res.json({ success: true });
});

// Admin workspace management
router.get('/workspaces', async (req, res) => {
  const workspaces = await db.all(`
    SELECT w.*, u.username as owner_name,
           (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) as member_count
    FROM workspaces w
    JOIN users u ON u.id = w.owner_id
    WHERE w.status = 'active'
    ORDER BY w.created_at DESC
  `);
  res.json((workspaces || []).map(w => ({ ...w, member_role: 'admin' })));
});

router.get('/workspaces/:id', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const workspace = await db.get(`
    SELECT w.*, u.username as owner_name
    FROM workspaces w
    JOIN users u ON u.id = w.owner_id
    WHERE w.id = ?
  `, [workspaceId]);
  if (!workspace) {
    return res.status(404).json({ error: '工作空间不存在' });
  }

  const members = await db.all(`
    SELECT wm.*, u.username, u.role as user_role
    FROM workspace_members wm
    JOIN users u ON u.id = wm.user_id
    WHERE wm.workspace_id = ?
  `, [workspaceId]);

  res.json({ ...workspace, members, member_role: 'admin' });
});

router.put('/workspaces/:id/quota', async (req, res) => {
  const workspaceId = parseInt(req.params.id);
  const { token_quota_limit } = req.body;

  const workspace = await db.get('SELECT id FROM workspaces WHERE id = ?', [workspaceId]);
  if (!workspace) {
    return res.status(404).json({ error: '工作空间不存在' });
  }

  const tql = parseFloat(token_quota_limit);
  if (!isFinite(tql) || tql < 0 || tql > 999999999999) {
    return res.status(400).json({ error: 'token_quota_limit 超出有效范围' });
  }

  await db.run('UPDATE workspaces SET token_quota_limit = ? WHERE id = ?', [tql, workspaceId]);
  res.json({ success: true, token_quota_limit: tql });
});

/**
 * @swagger
 * /admin/keys/concurrency:
 *   get:
 *     summary: Get live key-level concurrency and rate-limit counters
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: workspace_id
 *         schema:
 *           type: integer
 *         description: Filter by workspace id
 *     responses:
 *       200:
 *         description: Live counters keyed by key id
 */
router.get('/keys/concurrency', async (req, res) => {
  const workspaceId = req.query.workspace_id ? parseInt(req.query.workspace_id) : null;
  let keys;
  if (workspaceId && !isNaN(workspaceId)) {
    keys = await db.all(
      `SELECT id, max_concurrent, rate_limit FROM user_keys WHERE workspace_id = ?`,
      [workspaceId]
    );
  } else {
    keys = await db.all(
      `SELECT id, max_concurrent, rate_limit FROM user_keys`
    );
  }

  const result = {};
  for (const k of keys) {
    const counters = await rateLimitMiddleware.getKeyCounters(k.id);
    result[k.id] = {
      max_concurrent: Number.isFinite(Number(k.max_concurrent)) ? Number(k.max_concurrent) : 500,
      rate_limit: Number.isFinite(Number(k.rate_limit)) ? Number(k.rate_limit) : 60,
      current_concurrent: counters.currentConcurrent,
      current_rate: counters.currentRate,
      window_start: counters.windowStart
    };
  }
  res.json(result);
});

/**
 * @swagger
 * /admin/stats/overview:
 *   get:
 *     summary: Get dashboard overview stats
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard statistics
 */
// In-flight promise to prevent cache stampede on stats/overview
let _overviewPromise = null;

router.get('/stats/overview', async (req, res) => {
  const cacheKey = 'admin:stats:overview';
  const cacheTTL = 30; // seconds; aligns with polling cadence and reduces DB load

  try {
    const cached = await cacheService.get(cacheKey);
    if (cached) return res.json(cached);
  } catch (e) {
    // ignore cache read error
  }

  // Cache stampede protection: only one request computes stats at a time.
  // Others wait for the same result. If it fails, fall through and recompute.
  if (_overviewPromise) {
    try {
      const result = await _overviewPromise;
      return res.json(result);
    } catch (e) {
      // Fall through to compute ourselves
    }
  }

  const currentPromise = (async () => {
    // Use UTC date/hour strings to match the aggregation tables populated by the write path.
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoStr = sevenDaysAgo.toISOString().slice(0, 10);
    const sevenDaysAgoHour = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoHourStr = `${sevenDaysAgoHour.toISOString().slice(0, 10)} ${String(sevenDaysAgoHour.getUTCHours()).padStart(2, '0')}:00`;

    // Check whether aggregation tables have data so we can fall back to request_logs during migration.
    const hasDailyAgg = await db.get('SELECT COUNT(*) as count FROM user_daily_model_stats').then(r => (r?.count || 0) > 0);
    const hasHourlyAgg = await db.get('SELECT COUNT(*) as count FROM user_hourly_model_stats').then(r => (r?.count || 0) > 0);
    const hasSourceAgg = await db.get('SELECT COUNT(*) as count FROM source_daily_model_stats').then(r => (r?.count || 0) > 0);

    const todayP = hasDailyAgg
      ? db.get(`
          SELECT
            COALESCE(SUM(requests), 0) as requests,
            COALESCE(SUM(tokens), 0) as tokens,
            COALESCE(SUM(cost), 0) as cost,
            COALESCE(SUM(latency_ms_sum) / NULLIF(SUM(latency_ms_count), 0), 0) as avg_latency
          FROM user_daily_model_stats
          WHERE date = ?
        `, [todayStr])
      : db.get(`
          SELECT
            COUNT(*) as requests,
            SUM(total_tokens) as tokens,
            SUM(cost) as cost,
            AVG(latency_ms) as avg_latency
          FROM request_logs
          WHERE date(created_at) = date('now')
        `);

    const totalP = hasDailyAgg
      ? db.get(`
          SELECT
            COALESCE(SUM(requests), 0) as requests,
            COALESCE(SUM(tokens), 0) as tokens,
            COALESCE(SUM(cost), 0) as cost
          FROM user_daily_model_stats
        `)
      : db.get(`
          SELECT
            COUNT(*) as requests,
            SUM(total_tokens) as tokens,
            SUM(cost) as cost
          FROM request_logs
        `);

    const byModelP = hasDailyAgg
      ? db.all(`
          SELECT model, SUM(requests) as count, SUM(tokens) as tokens, SUM(cost) as cost
          FROM user_daily_model_stats
          WHERE date >= ?
          GROUP BY model
          ORDER BY tokens DESC
          LIMIT 10
        `, [sevenDaysAgoStr]).then(rows => rows.length ? rows : db.all(`
          SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens, SUM(cost) as cost
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY model
          ORDER BY count DESC
          LIMIT 10
        `))
      : db.all(`
          SELECT model, COUNT(*) as count, SUM(total_tokens) as tokens, SUM(cost) as cost
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY model
          ORDER BY count DESC
          LIMIT 10
        `);

    const bySourceP = hasSourceAgg
      ? db.all(`
          SELECT s.name,
                 COALESCE(SUM(agg.requests), 0) as count,
                 COALESCE(SUM(agg.tokens), 0) as tokens,
                 COALESCE(SUM(agg.cost), 0) as cost,
                 s.total_requests,
                 s.total_tokens as source_total_tokens
          FROM (
            SELECT source_id, model, SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost
            FROM source_daily_model_stats
            WHERE date >= ?
            GROUP BY source_id, model
          ) agg
          JOIN sources s ON agg.source_id = s.id
          GROUP BY s.id, s.name, s.total_requests, s.total_tokens
          ORDER BY count DESC
        `, [sevenDaysAgoStr]).then(rows => rows.length ? rows : db.all(`
          SELECT s.name, COUNT(*) as count, SUM(r.total_tokens) as tokens,
                 SUM(r.cost) as cost, s.total_requests, s.total_tokens as source_total_tokens
          FROM request_logs r
          JOIN sources s ON r.source_id = s.id
          WHERE r.created_at > datetime('now', '-7 days')
          GROUP BY r.source_id, s.name, s.total_requests, s.total_tokens
          ORDER BY count DESC
        `))
      : db.all(`
          SELECT s.name, COUNT(*) as count, SUM(r.total_tokens) as tokens,
                 SUM(r.cost) as cost, s.total_requests, s.total_tokens as source_total_tokens
          FROM request_logs r
          JOIN sources s ON r.source_id = s.id
          WHERE r.created_at > datetime('now', '-7 days')
          GROUP BY r.source_id, s.name, s.total_requests, s.total_tokens
          ORDER BY count DESC
        `);

    const dailyCostP = hasDailyAgg
      ? db.all(`
          SELECT date, SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost
          FROM user_daily_model_stats
          WHERE date >= ?
          GROUP BY date
          ORDER BY date ASC
        `, [sevenDaysAgoStr]).then(rows => rows.length ? rows : db.all(`
          SELECT date(created_at) as date, SUM(cost) as cost, SUM(total_tokens) as tokens, COUNT(*) as requests
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY date(created_at)
          ORDER BY date ASC
        `))
      : db.all(`
          SELECT date(created_at) as date, SUM(cost) as cost, SUM(total_tokens) as tokens, COUNT(*) as requests
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY date(created_at)
          ORDER BY date ASC
        `);

    const hourlyTrendP = hasHourlyAgg
      ? db.all(`
          SELECT hour as hour, SUM(requests) as requests, SUM(tokens) as tokens, SUM(cost) as cost
          FROM user_hourly_model_stats
          WHERE hour >= ?
          GROUP BY hour
          ORDER BY hour ASC
        `, [sevenDaysAgoHourStr]).then(rows => rows.length ? rows : db.all(`
          SELECT
            strftime('%Y-%m-%d %H:00', created_at) as hour,
            COUNT(*) as requests,
            SUM(total_tokens) as tokens,
            SUM(cost) as cost
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY hour
          ORDER BY hour ASC
        `))
      : db.all(`
          SELECT
            strftime('%Y-%m-%d %H:00', created_at) as hour,
            COUNT(*) as requests,
            SUM(total_tokens) as tokens,
            SUM(cost) as cost
          FROM request_logs
          WHERE created_at > datetime('now', '-7 days')
          GROUP BY hour
          ORDER BY hour ASC
        `);

    const concurrencyP = dispatcher.getConcurrencyStatus();

    const [today, total, byModel, bySource, dailyCost, hourlyTrend, concurrency] = await Promise.all([
      todayP, totalP, byModelP, bySourceP, dailyCostP, hourlyTrendP, concurrencyP
    ]);

    if (process.env.LOG_LEVEL === 'debug') {
      console.log('[stats/overview] today:', JSON.stringify(today));
      console.log('[stats/overview] byModel count:', byModel?.length, 'data:', JSON.stringify(byModel));
    }

    return { today, total, byModel, bySource, dailyCost, hourlyTrend, concurrency };
  })();
  _overviewPromise = currentPromise;

  try {
    const result = await currentPromise;
    try {
      await cacheManager.set(cacheKey, result, cacheTTL, { tags: ['admin:stats'] });
    } catch (e) {
      // ignore cache write error
    }
    res.json(result);
  } catch (e) {
    console.error('[stats/overview] failed:', e?.message);
    res.status(500).json({ error: 'Failed to compute dashboard stats' });
  } finally {
    if (_overviewPromise === currentPromise) {
      _overviewPromise = null;
    }
  }
});

router.get('/stats/logs', async (req, res) => {
  const { page = 1, pageSize = 20, user_id, source_id, start_date, end_date } = req.query;
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  let countSql = `SELECT COUNT(*) as total FROM request_logs r WHERE 1=1`;
  let sql = `SELECT r.*, u.username, s.name as source_name FROM request_logs r LEFT JOIN users u ON r.user_id = u.id LEFT JOIN sources s ON r.source_id = s.id WHERE 1=1`;
  const params = [];
  const countParams = [];

  // Default to last 7 days to avoid scanning the whole huge table.
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultEnd = now.toISOString().slice(0, 10);
  const rangeStart = start_date || defaultStart;
  const rangeEnd = end_date || defaultEnd;
  sql += ' AND r.created_at >= ? AND r.created_at < ?';
  countSql += ' AND r.created_at >= ? AND r.created_at < ?';
  const nextDay = new Date(new Date(rangeEnd).getTime() + 86400000).toISOString().slice(0, 10);
  params.push(rangeStart, nextDay);
  countParams.push(rangeStart, nextDay);

  if (user_id) {
    sql += ' AND r.user_id = ?';
    countSql += ' AND r.user_id = ?';
    params.push(parseInt(user_id));
    countParams.push(parseInt(user_id));
  }
  if (source_id) {
    sql += ' AND r.source_id = ?';
    countSql += ' AND r.source_id = ?';
    params.push(parseInt(source_id));
    countParams.push(parseInt(source_id));
  }

  let total;
  if (!user_id && !source_id) {
    // Fast estimate for unfiltered count; avoids a heavy COUNT(*) scan on huge request_logs.
    const estimate = await db.get("SELECT reltuples::bigint as total FROM pg_class WHERE relname = 'request_logs'");
    total = estimate?.total || 0;
  } else {
    const countResult = await db.get(countSql, countParams);
    total = countResult?.total || 0;
  }

  sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(ps, offset);

  let logs = await db.all(sql, params);
  // Format dates to readable strings to avoid Invalid Date in frontend
  logs = logs.map(log => ({
    ...log,
    created_at: log.created_at ? new Date(log.created_at).toLocaleString('zh-CN') : '-'
  }));
  res.json({ logs, total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps) });
});

// Per-range in-flight promises to prevent cache stampede on stats/tokens
const _tokensPromises = new Map();

router.get('/stats/tokens', async (req, res) => {
  const range = req.query.range || '30d';
  const cacheKey = `admin:stats:tokens:${range}`;
  const cacheTTL = 30; // seconds

  try {
    const cached = await cacheService.get(cacheKey);
    if (cached) return res.json(cached);
  } catch (e) {
    // ignore cache read error
  }

  // Cache stampede protection per range
  const existingPromise = _tokensPromises.get(range);
  if (existingPromise) {
    try {
      const result = await existingPromise;
      return res.json(result);
    } catch (e) {
      // fall through to compute ourselves
    }
  }

  const currentPromise = (async () => {
    const now = new Date();
    const hasDailyAgg = await db.get('SELECT COUNT(*) as count FROM user_daily_model_stats').then(r => (r?.count || 0) > 0);
    const hasHourlyAgg = await db.get('SELECT COUNT(*) as count FROM user_hourly_model_stats').then(r => (r?.count || 0) > 0);

    // 5m still scans request_logs (small volume).
    // 1h/6h/24h read from hourly aggregate; 7d/30d read from daily aggregate.
    if (range === '5m') {
      return db.all(`
        SELECT
          strftime('%Y-%m-%d %H:%M', created_at) as date,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cost) as cost
        FROM request_logs
        WHERE created_at > datetime('now', '-5 minutes')
        GROUP BY date
        ORDER BY date ASC
      `);
    }

    if (range === '1h' || range === '6h' || range === '24h') {
      const hoursBack = range === '1h' ? 1 : range === '6h' ? 6 : 24;
      const start = new Date(now.getTime() - hoursBack * 60 * 60 * 1000);
      const startHourStr = `${start.toISOString().slice(0, 10)} ${String(start.getUTCHours()).padStart(2, '0')}:00`;

      if (hasHourlyAgg) {
        return db.all(`
          SELECT
            hour as date,
            SUM(requests) as requests,
            SUM(tokens) as tokens,
            0 as input_tokens,
            0 as output_tokens,
            SUM(cost) as cost
          FROM user_hourly_model_stats
          WHERE hour >= ?
          GROUP BY hour
          ORDER BY hour ASC
        `, [startHourStr]).then(rows => rows.length ? rows : db.all(`
          SELECT
            strftime('%Y-%m-%d %H:00', created_at) as date,
            COUNT(*) as requests,
            SUM(total_tokens) as tokens,
            SUM(input_tokens) as input_tokens,
            SUM(output_tokens) as output_tokens,
            SUM(cost) as cost
          FROM request_logs
          WHERE created_at > NOW() - INTERVAL '${hoursBack} hours'
          GROUP BY date
          ORDER BY date ASC
        `));
      }

      return db.all(`
        SELECT
          TO_CHAR(created_at, 'YYYY-MM-DD HH24:00') as date,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cost) as cost
        FROM request_logs
        WHERE created_at > NOW() - INTERVAL '${hoursBack} hours'
        GROUP BY date
        ORDER BY date ASC
      `);
    }

    const daysBack = range === '7d' ? 7 : 30;
    const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    const startDateStr = start.toISOString().slice(0, 10);

    if (hasDailyAgg) {
      return db.all(`
        SELECT
          date as date,
          SUM(requests) as requests,
          SUM(tokens) as tokens,
          0 as input_tokens,
          0 as output_tokens,
          SUM(cost) as cost
        FROM user_daily_model_stats
        WHERE date >= ?
        GROUP BY date
        ORDER BY date ASC
      `, [startDateStr]).then(rows => rows.length ? rows : db.all(`
        SELECT
          created_at::date as date,
          COUNT(*) as requests,
          SUM(total_tokens) as tokens,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens,
          SUM(cost) as cost
        FROM request_logs
        WHERE created_at > NOW() - INTERVAL '${daysBack} days'
        GROUP BY created_at::date
        ORDER BY date ASC
      `));
    }

    return db.all(`
      SELECT
        created_at::date as date,
        COUNT(*) as requests,
        SUM(total_tokens) as tokens,
        SUM(input_tokens) as input_tokens,
        SUM(output_tokens) as output_tokens,
        SUM(cost) as cost
      FROM request_logs
      WHERE created_at > NOW() - INTERVAL '${daysBack} days'
      GROUP BY created_at::date
      ORDER BY date ASC
    `);
  })();
  _tokensPromises.set(range, currentPromise);

  try {
    const daily = await currentPromise;
    try {
      await cacheManager.set(cacheKey, daily, cacheTTL, { tags: ['admin:stats'] });
    } catch (e) {
      // ignore cache write error
    }
    res.json(daily);
  } catch (e) {
    console.error('[stats/tokens] failed:', e?.message);
    res.status(500).json({ error: 'Failed to compute token stats' });
  } finally {
    if (_tokensPromises.get(range) === currentPromise) {
      _tokensPromises.delete(range);
    }
  }
});

router.get('/dispatch-rules', async (req, res) => {
  const rules = await db.all('SELECT * FROM dispatch_rules ORDER BY priority DESC');
  res.json(rules);
});

router.post('/dispatch-rules', async (req, res) => {
  const { name, strategy, model_filter, source_filter, priority, is_active } = req.body;

  const result = await db.run(
    `INSERT INTO dispatch_rules (name, strategy, model_filter, source_filter, priority, is_active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, strategy || 'round_robin', model_filter, source_filter, priority || 0, is_active ?? 1]
  );

  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/dispatch-rules/:id', async (req, res) => {
  const { id } = req.params;
  const { name, strategy, model_filter, source_filter, priority, is_active } = req.body;

  const fields = [];
  const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (strategy !== undefined) { fields.push('strategy = ?'); params.push(strategy); }
  if (model_filter !== undefined) { fields.push('model_filter = ?'); params.push(model_filter); }
  if (source_filter !== undefined) { fields.push('source_filter = ?'); params.push(source_filter); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (is_active !== undefined) { fields.push('is_active = ?'); params.push(asBool(is_active, false)); }
  if (fields.length === 0) return res.json({ success: true, no_changes: true });
  params.push(parseInt(id));
  await db.run(`UPDATE dispatch_rules SET ${fields.join(', ')} WHERE id = ?`, params);

  res.json({ success: true });
});

router.delete('/dispatch-rules/:id', async (req, res) => {
  await db.run('DELETE FROM dispatch_rules WHERE id = ?', [parseInt(req.params.id)]);
  res.json({ success: true });
});

router.get('/settings', async (req, res) => {
  const settings = await db.all('SELECT * FROM settings');
  const result = {};
  for (const s of settings) {
    result[s.key] = ['gateway_urls', 'gateway_url', 'banner_text', 'banner_enabled'].includes(s.key)
      ? unescapeHtml(s.value)
      : s.value;
  }
  res.json(result);
});

router.put('/settings', async (req, res) => {
  let { key, value } = req.body;

  // The global input sanitizer HTML-escapes string values. For functional
  // settings that store JSON or raw text (gateway URLs, banner text), restore
  // the original characters so they remain parseable after a restart.
  if (key === 'gateway_urls' || key === 'gateway_url' || key === 'banner_text' || key === 'banner_enabled') {
    value = unescapeHtml(value);
  }

  // Validate gateway_urls structure if present
  if (key === 'gateway_urls' && value) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return res.status(400).json({ error: 'gateway_urls 不是有效的 JSON' });
    }
    if (!Array.isArray(parsed)) {
      return res.status(400).json({ error: 'gateway_urls 必须是数组' });
    }
    for (const item of parsed) {
      if (!item.url || typeof item.url !== 'string') {
        return res.status(400).json({ error: '每个网关地址必须包含 url 字段' });
      }
      if (item.type && !['node', 'nginx'].includes(item.type)) {
        return res.status(400).json({ error: '网关地址类型必须是 node 或 nginx' });
      }
    }
  }

  await db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, value]
  );

  // 根据 setting key 失效对应缓存命名空间，并同步运行时状态
  if (key === 'dispatch_strategy') {
    await cacheManager.invalidateTags(['settings']);
  } else if (key === 'exchange_rate') {
    await cacheManager.invalidateTags(['currency']);
  } else if (key === 'log_level') {
    process.env.LOG_LEVEL = value;
  } else if (key === 'gateway_urls' || key === 'gateway_url' || key === 'banner_text' || key === 'banner_enabled') {
    await cacheManager.invalidateTags(['settings', 'public_settings']);
  }

  res.json({ success: true });
});

/**
 * @swagger
 * /admin/server-config:
 *   get:
 *     summary: Get server port configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current server.json content
 */
router.get('/server-config', async (req, res) => {
  try {
    let cfg = {};
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
      cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
    }
    const control = readNginxControl(PROJECT_ROOT);
    res.json({
      ...cfg,
      nginx_controlled: control.controlled === true,
      nginx_capabilities: control.capabilities || {},
    });
  } catch (e) {
    console.error('[Admin] Failed to read server config:', e.message);
    res.status(500).json({ error: '读取服务端口配置失败' });
  }
});

/**
 * @swagger
 * /admin/nginx-status:
 *   get:
 *     summary: Get Nginx process and control status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Nginx status
 */
router.get('/nginx-status', async (req, res) => {
  try {
    const control = readNginxControl(PROJECT_ROOT);
    const running = await isNginxRunning();
    const processes = await getNginxProcessInfo();

    const managedPaths = new Set();
    const externalPaths = new Set();
    processes.forEach((p) => {
      const exePath = path.resolve(p.path || '');
      const isManaged = exePath.startsWith(NGINX_DIR + path.sep) || exePath === NGINX_DIR;
      if (isManaged) managedPaths.add(exePath);
      else externalPaths.add(exePath);
    });

    const managedCount = managedPaths.size;
    const externalCount = externalPaths.size;

    let status = 'unused';
    if (control.controlled) {
      if (running && managedCount > 0) {
        status = externalCount > 0 ? 'dual' : 'managed_running';
      } else if (running && externalCount > 0) {
        status = externalCount > 1 ? 'multiple' : 'external_running';
      } else if (running) {
        status = 'running_unknown';
      } else {
        status = 'error';
      }
    } else {
      if (running && externalCount > 0) {
        status = externalCount > 1 ? 'multiple' : 'external_running';
      } else if (running) {
        status = 'running_unknown';
      } else {
        status = 'unused';
      }
    }

    res.json({
      controlled: control.controlled === true,
      running,
      status,
      managedCount,
      externalCount,
      processCount: processes.length,
      binary: control.binary || null,
      capabilities: control.capabilities || {},
      timestamp: control.timestamp || null,
    });
  } catch (e) {
    console.error('[Admin] Failed to read nginx status:', e.message);
    res.status(500).json({ error: '读取 Nginx 状态失败' });
  }
});

/**
 * @swagger
 * /admin/server-config:
 *   put:
 *     summary: Update Node.js and Nginx port configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ports:
 *                 type: object
 *                 properties:
 *                   api: { type: integer }
 *                   admin: { type: integer }
 *                   user: { type: integer }
 *               nginx:
 *                 type: object
 *                 properties:
 *                   user_listen: { type: integer }
 *                   admin_listen: { type: integer }
 *                   server_name: { type: string }
 *     responses:
 *       200:
 *         description: Config updated
 */
router.put('/server-config', async (req, res) => {
  try {
    let current = {};
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
      current = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
    }

    const next = normalizeServerConfig(req.body, current);
    let validationError = validateServerConfig(next);
    if (!validationError) {
      validationError = validateSecurityConfig(next);
    }
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');

    // Regenerate nginx.conf with new ports
    generateNginxConfig({ root: PROJECT_ROOT });

    // Try to hot-reload nginx if it is running
    const reloadResult = await reloadNginx();
    const restartRequired = configRequiresRestart(current, next);

    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'update',
      resourceType: 'setting',
      resourceName: 'server-config',
      oldValue: current,
      newValue: next,
      req
    });

    res.json({
      success: true,
      config: next,
      nginx_reloaded: reloadResult.success,
      nginx_reload_message: reloadResult.success ? undefined : reloadResult.message,
      restart_required: restartRequired,
    });
  } catch (e) {
    console.error('[Admin] Failed to update server config:', e.message);
    res.status(500).json({ error: '更新服务端口配置失败: ' + e.message });
  }
});

/**
 * @swagger
 * /admin/routing/status:
 *   get:
 *     summary: Get smart routing status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Routing status
 */
router.get('/routing/status', async (req, res) => {
  const status = await smartRoutingService.getRoutingStatus();
  res.json(status);
});

/**
 * @swagger
 * /admin/routing/mode:
 *   put:
 *     summary: Set routing mode (auto/manual)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [auto, manual]
 *     responses:
 *       200:
 *         description: Mode updated
 */
router.put('/routing/mode', async (req, res) => {
  const { mode } = req.body;
  if (!['auto', 'manual'].includes(mode)) {
    return res.status(400).json({ error: 'Invalid mode, must be auto or manual' });
  }

  await smartRoutingService.setRoutingMode(mode);
  res.json({ success: true, mode });
  adminEvents.broadcast('routing.changed', { type: 'mode_updated', mode });
});

/**
 * @swagger
 * /admin/routing/sources/:id/status:
 *   put:
 *     summary: Manually set source direct status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               status:
 *                 type: string
 *                 enum: [enabled, disabled, pending]
 *     responses:
 *       200:
 *         description: Status updated
 */
/**
 * @swagger
 * /admin/routing/sources/:id/relay-source:
 *   put:
 *     summary: Set relay source for a source
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               relaySourceId:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Relay source updated
 */
router.put('/routing/sources/:id/relay-source', async (req, res) => {
  const { id } = req.params;
  const { relaySourceId } = req.body;
  try {
    await db.run('UPDATE sources SET relay_source_id = ? WHERE id = ?', [relaySourceId, id]);
    res.json({ success: true });
    adminEvents.broadcast('routing.changed', { type: 'relay_updated', sourceId: parseInt(id), relaySourceId });
  } catch (e) {
    console.error('[Admin] Relay source update error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/routing/sources/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!['enabled', 'disabled', 'pending'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  await smartRoutingService.updateSourceDirectStatus(parseInt(id), status);
  res.json({ success: true });
  adminEvents.broadcast('routing.changed', { type: 'source_status_updated', sourceId: parseInt(id), status });
});

/**
 * @swagger
 * /admin/routing/config/status:
 *   get:
 *     summary: Get routing config status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Config status
 */
router.get('/routing/config/status', async (req, res) => {
  try {
    const status = await routingConfig.getStatus();
    const sessionStats = await sessionTracker.getStats();
    const cacheStatus = routingLoader.getCacheStatus();
    
    res.json({
      ...status,
      sessions: sessionStats,
      loader: cacheStatus
    });
  } catch (e) {
    console.error('[Admin] Failed to get config status:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/routing/config/save:
 *   post:
 *     summary: Save current routing config as new version
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config:
 *                 type: object
 *     responses:
 *       200:
 *         description: Config saved
 */
router.post('/routing/config/save', async (req, res) => {
  try {
    const { config } = req.body;
    
    // 如果没有提供配置，从当前数据库状态获取
    const configToSave = config || await routingConfig.getCurrentConfig();
    
    const result = await routingConfig.createVersion(configToSave);
    
    // 记录审计日志
    await audit.log(req.user.id, 'routing_config_save', {
      version: result.version,
      sources_count: result.config.sources.length
    });
    
    res.json({ success: true, version: result.version });
    adminEvents.broadcast('routing.changed', { type: 'config_saved', version: result.version });
  } catch (e) {
    console.error('[Admin] Failed to save config:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/routing/config/activate:
 *   post:
 *     summary: Activate a routing config version
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               version:
 *                 type: integer
 *     responses:
 *       200:
 *         description: Config activated
 */
router.post('/routing/config/activate', async (req, res) => {
  try {
    const { version } = req.body;
    
    if (!version) {
      return res.status(400).json({ error: 'Version is required' });
    }
    
    await routingConfig.activateVersion(version);
    
    // 清除加载器缓存
    routingLoader.clearCache();
    
    // 记录审计日志
    await audit.log(req.user.id, 'routing_config_activate', { version });
    
    res.json({ success: true, version });
    adminEvents.broadcast('routing.changed', { type: 'config_activated', version });
  } catch (e) {
    console.error('[Admin] Failed to activate config:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/routing/config/hot-restart:
 *   post:
 *     summary: Hot restart to apply new config
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Hot restart completed
 */
router.post('/routing/config/hot-restart', async (req, res) => {
  try {
    // 获取当前活跃配置
    const active = await routingConfig.getActiveVersion();
    
    if (!active) {
      return res.status(400).json({ error: 'No active config found' });
    }
    
    // 清除所有缓存
    routingLoader.clearCache();
    await routingConfig.clearCache();
    
    // 预加载活跃配置
    await routingLoader.preloadConfig(active.version);
    
    // 记录审计日志
    await audit.log(req.user.id, 'routing_config_hot_restart', { version: active.version });
    
    res.json({ 
      success: true, 
      version: active.version,
      message: 'Hot restart completed. New config will be applied to new sessions.'
    });
    adminEvents.broadcast('routing.changed', { type: 'hot_restarted', version: active.version });
  } catch (e) {
    console.error('[Admin] Failed to hot restart:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/routing/config/versions:
 *   get:
 *     summary: List all routing config versions
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Config versions list
 */
router.get('/routing/config/versions', async (req, res) => {
  try {
    const versions = await routingConfig.listVersions();
    res.json(versions);
  } catch (e) {
    console.error('[Admin] Failed to list versions:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/routing/config/versions/:version:
 *   delete:
 *     summary: Delete a routing config version
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Config version deleted
 */
router.delete('/routing/config/versions/:version', async (req, res) => {
  try {
    const { version } = req.params;
    await routingConfig.deleteVersion(parseInt(version));
    
    // 记录审计日志
    await audit.log(req.user.id, 'routing_config_delete', { version });
    
    res.json({ success: true });
  } catch (e) {
    console.error('[Admin] Failed to delete version:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/database/status:
 *   get:
 *     summary: Get database status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Database status
 */
router.get('/database/status', async (req, res) => {
  try {
    const redisStatus = getRedisStatus();
    const redisConfig = getRedisConfig();
    
    // 检查 PostgreSQL 状态
    let pgStatus = { connected: false, error: null };
    try {
      await db.get('SELECT 1');
      pgStatus.connected = true;
    } catch (e) {
      pgStatus.error = e.message;
    }

    // 获取缓存状态
    let cacheStatus = { useRedis: false, memoryCacheSize: 0, redisConnected: false };
    try {
      const cache = require('../services/cache');
      cacheStatus = cache.getStatus();
    } catch (e) {
      console.error('[Admin] Failed to get cache status:', e);
    }

    res.json({
      postgresql: {
        connected: pgStatus.connected,
        error: pgStatus.error,
        adapter: 'postgresql'
      },
      redis: {
        connected: redisStatus.connected,
        ready: redisStatus.ready,
        url: redisStatus.url,
        latency: redisStatus.latency,
        config: {
          enabled: redisConfig?.enabled,
          database: redisConfig?.database,
          keyPrefix: redisConfig?.keyPrefix
        }
      },
      cache: cacheStatus
    });
  } catch (e) {
    console.error('[Admin] Failed to get database status:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/database/redis/reconnect:
 *   post:
 *     summary: Reconnect Redis
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Redis reconnected
 */
router.post('/database/redis/reconnect', async (req, res) => {
  try {
    await reconnectRedis();
    const status = getRedisStatus();
    res.json({ success: true, status });
  } catch (e) {
    console.error('[Admin] Failed to reconnect Redis:', e);
    res.status(500).json({ error: e.message });
  }
});

// ========== Cache Management ==========

/**
 * @swagger
 * /admin/cache/status:
 *   get:
 *     summary: Get cache status and tag statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Cache status
 */
router.get('/cache/status', async (req, res) => {
  try {
    const stats = await cacheManager.stats();
    res.json(stats);
  } catch (e) {
    console.error('[Admin] Failed to get cache status:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/cache/keys:
 *   get:
 *     summary: List cache keys by pattern
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: pattern
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: List of keys
 */
router.get('/cache/keys', async (req, res) => {
  try {
    const pattern = req.query.pattern || '*';
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 100));
    const keys = await cacheManager.keys(pattern, limit);
    res.json({ pattern, limit, keys });
  } catch (e) {
    console.error('[Admin] Failed to list cache keys:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/cache/invalidate:
 *   post:
 *     summary: Invalidate cache by tags/namespaces/patterns/keys
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *     responses:
 *       200:
 *         description: Invalidated
 */
router.post('/cache/invalidate', async (req, res) => {
  try {
    const { tags, namespaces, patterns, keys } = req.body;
    let deleted = 0;
    if (Array.isArray(tags) && tags.length > 0) {
      deleted += (await cacheManager.invalidateTags(tags)).deleted;
    }
    if (Array.isArray(namespaces) && namespaces.length > 0) {
      deleted += (await cacheManager.invalidateNamespaces(namespaces)).deleted;
    }
    if (Array.isArray(patterns) && patterns.length > 0) {
      deleted += (await cacheManager.invalidatePatterns(patterns)).deleted;
    }
    if (Array.isArray(keys) && keys.length > 0) {
      deleted += (await cacheManager.invalidateKeys(keys)).deleted;
    }
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('[Admin] Failed to invalidate cache:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/cache/flush:
 *   post:
 *     summary: Flush all tracked business cache keys
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *     responses:
 *       200:
 *         description: Flushed
 */
router.post('/cache/flush', async (req, res) => {
  try {
    const result = await cacheManager.flush({ confirm: req.body.confirm === true });
    if (result.error) {
      return res.status(400).json(result);
    }
    res.json({ success: true, deleted: result.deleted });
  } catch (e) {
    console.error('[Admin] Failed to flush cache:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/cache/reconnect:
 *   post:
 *     summary: Reconnect Redis and reinitialize cache service
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Reconnected
 */
router.post('/cache/reconnect', async (req, res) => {
  try {
    await reconnectRedis();
    await cacheService.initRedis();
    res.json({ success: true, status: cacheService.getStatus() });
  } catch (e) {
    console.error('[Admin] Failed to reconnect cache:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/database/execute:
 *   post:
 *     summary: Execute SQL command (admin only)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               sql:
 *                 type: string
 *     responses:
 *       200:
 *         description: SQL executed
 */
router.post('/database/execute', async (req, res) => {
  const { sql } = req.body;
  if (!sql) {
    return res.status(400).json({ error: 'SQL is required' });
  }

  const trimmed = sql.trim();

  // Security: reject multi-statement queries
  if (trimmed.includes(';')) {
    return res.status(403).json({ error: 'Multi-statement SQL is not allowed' });
  }

  // Only allow ALTER TABLE ... ADD COLUMN with a simple identifier.
  const allowedPattern = /^ALTER TABLE\s+[a-zA-Z_][a-zA-Z0-9_]*\s+ADD COLUMN\s+[a-zA-Z_][a-zA-Z0-9_]*\s+/i;
  if (!allowedPattern.test(trimmed)) {
    return res.status(403).json({ error: 'SQL command not allowed for security reasons' });
  }

  try {
    await db.run(trimmed);
    res.json({ success: true, message: 'SQL executed successfully' });
  } catch (e) {
    console.error('[Admin] SQL execution error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * @swagger
 * /admin/database/init:
 *   post:
 *     summary: Initialize database (re-run initDatabase)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Database initialized
 */
router.post('/database/init', async (req, res) => {
  try {
    const { initDatabase } = require('../config/database');
    await initDatabase();
    res.json({ success: true, message: 'Database initialized successfully' });
  } catch (e) {
    console.error('[Admin] Database init error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ========== Audit Logs ==========

router.get('/audit-logs/stats', async (req, res) => {
  const stats = await audit.getStats();
  res.json(stats);
});

router.get('/audit-logs', async (req, res) => {
  const { page, limit, action, resource_type, search, start_date, end_date } = req.query;
  const result = await audit.getLogs({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50,
    action,
    resourceType: resource_type,
    search,
    startDate: start_date,
    endDate: end_date
  });
  res.json(result);
});

// Database pool metrics
/**
 * @swagger
 * /admin/metrics/db:
 *   get:
 *     summary: Get database connection pool metrics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Database metrics
 */
router.get('/metrics/db', async (req, res) => {
  const pool = require('../config/db/postgres').pool;
  res.json({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  });
});

// Database pool metrics
router.get('/metrics/db', async (req, res) => {
  const { pool } = require('../config/db/postgres');
  res.json({
    total: pool.totalCount || 0,
    idle: pool.idleCount || 0,
    waiting: pool.waitingCount || 0,
  });
});

// Probe results
router.get('/sources/probe', async (req, res) => {
  const results = await probeService.getResults();
  const sources = await db.all('SELECT id, name FROM sources WHERE is_active = true');
  const out = [];
  for (const s of sources) {
    const probe = results[s.id] || {};
    out.push({ id: s.id, name: s.name, probe });
  }
  res.json(out);
});

// Initialize database.
// The PIN is controlled by the INIT_DATABASE_PIN environment variable and is never hard-coded.
const INIT_DATABASE_PIN = process.env.INIT_DATABASE_PIN;
router.post('/init-database', async (req, res) => {
  const { pin } = req.body;
  if (!INIT_DATABASE_PIN) {
    return res.status(503).json({ error: '数据库初始化 PIN 未配置，请在服务端设置 INIT_DATABASE_PIN 环境变量' });
  }
  if (pin !== INIT_DATABASE_PIN) {
    return res.status(403).json({ error: '密码错误' });
  }
  try {
    const { initDatabase } = require('../config/database');
    await initDatabase();
    res.json({ success: true, message: '数据库初始化成功' });
  } catch (err) {
    console.error('[InitDatabase] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// User logs (alias for audit logs with user-centric view)
router.get('/user-logs', async (req, res) => {
  const { page, limit, action, resource_type, search, start_date, end_date } = req.query;
  const result = await audit.getLogs({
    page: parseInt(page) || 1,
    limit: parseInt(limit) || 50,
    action,
    resourceType: resource_type,
    search,
    startDate: start_date,
    endDate: end_date
  });
  res.json(result);
});

// Token logs (request_logs query)
router.get('/token-logs', async (req, res) => {
  const { page = 1, pageSize = 50, user_id, source_id, model, start_date, end_date } = req.query;
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  let countSql = `SELECT COUNT(*) as total FROM request_logs r WHERE 1=1`;
  let sql = `SELECT r.*, u.username, s.name as source_name,
      ts.id as transit_scan_id, ts.result as transit_result, ts.matched_rules as transit_matched_rules,
      ts.details as transit_details, ts.payload_sample as transit_payload_sample
    FROM request_logs r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN sources s ON r.source_id = s.id
    LEFT JOIN transit_scans ts ON ts.request_uuid = r.request_uuid
    WHERE 1=1`;
  const params = [];
  const countParams = [];

  // Default to last 7 days to avoid scanning the whole huge table.
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const defaultEnd = now.toISOString().slice(0, 10);
  const rangeStart = start_date || defaultStart;
  const rangeEnd = end_date || defaultEnd;
  sql += ' AND r.created_at >= ? AND r.created_at < ?';
  countSql += ' AND r.created_at >= ? AND r.created_at < ?';
  const nextDay = new Date(new Date(rangeEnd).getTime() + 86400000).toISOString().slice(0, 10);
  params.push(rangeStart, nextDay);
  countParams.push(rangeStart, nextDay);

  if (user_id) {
    sql += ' AND r.user_id = ?';
    countSql += ' AND r.user_id = ?';
    params.push(parseInt(user_id));
    countParams.push(parseInt(user_id));
  }
  if (source_id) {
    sql += ' AND r.source_id = ?';
    countSql += ' AND r.source_id = ?';
    params.push(parseInt(source_id));
    countParams.push(parseInt(source_id));
  }
  if (model) {
    sql += ' AND r.model = ?';
    countSql += ' AND r.model = ?';
    params.push(model);
    countParams.push(model);
  }

  let total;
  if (!user_id && !source_id && !model) {
    // Fast estimate for unfiltered count; avoids a heavy COUNT(*) scan on huge request_logs.
    const estimate = await db.get("SELECT reltuples::bigint as total FROM pg_class WHERE relname = 'request_logs'");
    total = estimate?.total || 0;
  } else {
    const totalResult = await db.get(countSql, countParams);
    total = totalResult?.total || 0;
  }

  sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(ps, offset);

  const logs = await db.all(sql, params);
  res.json({ logs, total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps) });
});

// Transit security scan results
router.get('/transit-scans', async (req, res) => {
  const { page = 1, pageSize = 50, status } = req.query;
  const p = Math.max(1, parseInt(page));
  const ps = Math.min(100, Math.max(1, parseInt(pageSize)));
  const offset = (p - 1) * ps;

  let countSql = `SELECT COUNT(*) as total FROM transit_scans t WHERE 1=1`;
  let sql = `SELECT t.*, u.username, s.name as source_name FROM transit_scans t LEFT JOIN users u ON t.user_id = u.id LEFT JOIN sources s ON t.source_id = s.id WHERE 1=1`;
  const params = [];
  const countParams = [];

  if (status) {
    sql += ' AND t.result = ?';
    countSql += ' AND t.result = ?';
    params.push(status);
    countParams.push(status);
  }

  const totalResult = await db.get(countSql, countParams);
  const total = totalResult?.total || 0;

  sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
  params.push(ps, offset);

  const logs = await db.all(sql, params);
  res.json({ logs, total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps) });
});

router.get('/transit-scans/:id', async (req, res) => {
  const { id } = req.params;
  const row = await db.get(`
    SELECT t.*, u.username, s.name as source_name
    FROM transit_scans t
    LEFT JOIN users u ON t.user_id = u.id
    LEFT JOIN sources s ON t.source_id = s.id
    WHERE t.id = ?
  `, [id]);
  if (!row) return res.status(404).json({ error: 'Scan not found' });
  res.json(row);
});

// Clear logs (audit / token / user / transit / all)
router.delete('/logs/clear', async (req, res) => {
  try {
    const { type = 'audit' } = req.body;
    const allowedTypes = ['audit', 'user', 'token', 'transit', 'all'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid log type', allowed: allowedTypes });
    }

    let deleted = 0;

    // Audit/user logs are usually small; DELETE is fine and lets us keep the
    // "clear logs" audit record that we insert afterwards.
    if (type === 'audit' || type === 'user' || type === 'all') {
      deleted += await audit.clearLogs();
    }

    // Token/request logs can grow to hundreds of thousands of rows.
    // TRUNCATE is instant and avoids long-running DELETE/SELECT COUNT that
    // blocks the event loop and triggers the watchdog restart.
    // We use pg_class.reltuples for a fast approximate count before truncating.
    if (type === 'token' || type === 'all') {
      const countResult = await db.get("SELECT reltuples::bigint as total FROM pg_class WHERE relname = 'request_logs'");
      await db.run('TRUNCATE TABLE request_logs');
      deleted += countResult?.total || 0;
    }

    if (type === 'transit' || type === 'all') {
      const countResult = await db.get("SELECT reltuples::bigint as total FROM pg_class WHERE relname = 'transit_scans'");
      await db.run('TRUNCATE TABLE transit_scans');
      deleted += countResult?.total || 0;
    }

    // Invalidate dashboard stats cache so the UI reflects the cleared logs immediately
    try { await cacheManager.invalidateNamespaces(['admin:stats']); } catch (e) {}

    // Audit the clear action itself
    await audit.log({
      userId: req.user?.id,
      username: req.user?.username,
      action: 'delete',
      resourceType: 'system',
      resourceName: `clear_${type}_logs`,
      newValue: { type, deleted },
      req
    });

    res.json({ success: true, type, deleted });
  } catch (err) {
    console.error('[admin] /logs/clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear logs', message: err.message });
  }
});

/**
 * @swagger
 * /admin/audit/test:
 *   post:
 *     summary: Test audit log system
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [create, update, delete, login, logout, test, import, batch_update, batch_delete, toggle]
 *               resourceType:
 *                 type: string
 *                 enum: [source, model, model_group, user, key, dispatch_rule, setting, system]
 *               resourceName:
 *                 type: string
 *     responses:
 *       200:
 *         description: Audit log test successful
 */
router.post('/audit/test', async (req, res) => {
  try {
    const { action = 'test', resourceType = 'system', resourceName = 'test' } = req.body;
    const userId = req.user?.id;
    const username = req.user?.username;

    await audit.log({
      userId,
      username,
      action,
      resourceType,
      resourceName,
      req
    });

    res.json({ success: true, message: 'Audit log test successful' });
  } catch (e) {
    console.error('[Admin] Audit test failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ===== Log Management System =====

router.get('/log-management/stats', async (req, res) => {
  try {
    const stats = await logManagement.getStats();
    res.json(stats);
  } catch (e) {
    console.error('[Admin] log-management/stats failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/log-management/settings', async (req, res) => {
  try {
    const [defaultLimit, transitEnabled] = await Promise.all([
      logManagement.getDefaultLimit(),
      transitScanner.isEnabled()
    ]);
    res.json({ default_log_retention_limit: defaultLimit, transit_scan_enabled: transitEnabled });
  } catch (e) {
    console.error('[Admin] log-management/settings failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/log-management/settings', async (req, res) => {
  try {
    const { default_log_retention_limit, transit_scan_enabled } = req.body;
    const result = { success: true };
    if (default_log_retention_limit !== undefined) {
      result.default_log_retention_limit = await logManagement.setDefaultLimit(default_log_retention_limit);
    }
    if (transit_scan_enabled !== undefined) {
      result.transit_scan_enabled = await transitScanner.setEnabled(transit_scan_enabled);
    }
    res.json(result);
  } catch (e) {
    console.error('[Admin] log-management/settings update failed:', e);
    res.status(400).json({ error: e.message });
  }
});

router.get('/log-management/users', async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const result = await logManagement.getUsersWithCounts({
      page: parseInt(page, 10),
      pageSize: parseInt(pageSize, 10),
      search: String(search || '').trim()
    });
    res.json(result);
  } catch (e) {
    console.error('[Admin] log-management/users failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/log-management/users/:id/retention', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { log_retention_limit } = req.body;
    const value = await logManagement.setUserLimit(userId, log_retention_limit);
    res.json({ success: true, log_retention_limit: value });
  } catch (e) {
    console.error('[Admin] log-management/users/:id/retention failed:', e);
    res.status(400).json({ error: e.message });
  }
});

router.post('/log-management/users/:id/trim', async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const deleted = await logManagement.trimUserLogs(userId);
    res.json({ success: true, deleted });
  } catch (e) {
    console.error('[Admin] log-management/users/:id/trim failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/log-management/trim-all', async (req, res) => {
  try {
    // Run trim in background; do not block the admin dashboard
    setImmediate(async () => {
      try {
        const result = await logManagement.trimAllUsers();
        console.log('[LogManagement] trim-all completed:', result);
      } catch (e) {
        console.error('[LogManagement] trim-all failed:', e);
      }
    });
    res.json({ success: true, message: '全局清理已后台启动' });
  } catch (e) {
    console.error('[Admin] log-management/trim-all failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Periodically push live key-level concurrency/rate-limit status to admin SSE clients.
// Skip in test environment to avoid firing DB queries after Jest tears down the pool.
const CONCURRENCY_BROADCAST_INTERVAL_MS = 2000;
const concurrencyBroadcastInterval = process.env.NODE_ENV !== 'test' ? setInterval(async () => {
  if (adminEvents.getClientCount() === 0) return;
  try {
    const keys = await db.all(`
      SELECT k.id, k.workspace_id, k.max_concurrent, k.rate_limit
      FROM user_keys k
      WHERE k.workspace_id IS NOT NULL
    `);
    if (keys.length === 0) return;

    const payload = {};
    for (const k of keys) {
      const counters = await rateLimitMiddleware.getKeyCounters(k.id);
      payload[k.id] = {
        workspace_id: k.workspace_id,
        max_concurrent: Number.isFinite(Number(k.max_concurrent)) ? Number(k.max_concurrent) : 500,
        rate_limit: Number.isFinite(Number(k.rate_limit)) ? Number(k.rate_limit) : 60,
        current_concurrent: counters.currentConcurrent,
        current_rate: counters.currentRate,
        window_start: counters.windowStart
      };
    }
    adminEvents.broadcast('keys.concurrency', payload);
  } catch (e) {
    console.error('[Admin] concurrency broadcast failed:', e.message);
  }
}, CONCURRENCY_BROADCAST_INTERVAL_MS) : null;
if (concurrencyBroadcastInterval) concurrencyBroadcastInterval.unref?.();

// ========== Security: IP Blacklist Management ==========
function isValidCidr(ip) {
  if (!ip || typeof ip !== 'string') return false;
  // IPv4 with optional CIDR prefix
  const cidrRegex = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
  if (!cidrRegex.test(ip)) return false;
  const [addr, prefix] = ip.split('/');
  const octets = addr.split('.');
  for (const o of octets) {
    const n = parseInt(o, 10);
    if (Number.isNaN(n) || n < 0 || n > 255) return false;
  }
  if (prefix !== undefined) {
    const p = parseInt(prefix, 10);
    if (Number.isNaN(p) || p < 0 || p > 32) return false;
  }
  return true;
}

router.get('/security/ip-blacklist', async (req, res) => {
  try {
    const rows = await db.all('SELECT id, ip, reason, enabled, created_by, created_at, expires_at FROM ip_blacklists ORDER BY created_at DESC');
    res.json({ list: rows });
  } catch (e) {
    console.error('[Admin] failed to list IP blacklist:', e.message);
    res.status(500).json({ error: '获取 IP 黑名单失败' });
  }
});

router.post('/security/ip-blacklist', async (req, res) => {
  try {
    const { ip, reason, enabled, expires_at } = req.body;
    if (!isValidCidr(ip)) return res.status(400).json({ error: '无效的 IP 或 CIDR 格式' });
    const normalizedIp = ip.includes('/') ? ip : `${ip}/32`;
    const result = await db.run(
      `INSERT INTO ip_blacklists (ip, reason, enabled, created_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [normalizedIp, reason || null, enabled !== false, req.user.id, expires_at || null]
    );
    const { invalidateCache } = require('../middleware/ip-blacklist');
    invalidateCache();
    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'create',
      resourceType: 'ip_blacklist',
      resourceId: result.lastInsertRowid,
      resourceName: normalizedIp,
      newValue: { ip: normalizedIp, reason, enabled: enabled !== false, expires_at },
      req
    });
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (e) {
    console.error('[Admin] failed to add IP blacklist:', e.message);
    res.status(500).json({ error: '添加失败' });
  }
});

router.put('/security/ip-blacklist/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { ip, reason, enabled, expires_at } = req.body;
    const existing = await db.get('SELECT * FROM ip_blacklists WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    if (ip !== undefined && !isValidCidr(ip)) return res.status(400).json({ error: '无效的 IP 或 CIDR 格式' });
    const normalizedIp = ip === undefined ? existing.ip : (ip.includes('/') ? ip : `${ip}/32`);
    await db.run(
      `UPDATE ip_blacklists SET ip = ?, reason = ?, enabled = ?, expires_at = ? WHERE id = ?`,
      [normalizedIp, reason !== undefined ? reason : existing.reason, enabled !== undefined ? enabled : existing.enabled, expires_at !== undefined ? expires_at : existing.expires_at, id]
    );
    const { invalidateCache } = require('../middleware/ip-blacklist');
    invalidateCache();
    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'update',
      resourceType: 'ip_blacklist',
      resourceId: id,
      resourceName: normalizedIp,
      oldValue: existing,
      newValue: { ip: normalizedIp, reason, enabled, expires_at },
      req
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[Admin] failed to update IP blacklist:', e.message);
    res.status(500).json({ error: '更新失败' });
  }
});

router.delete('/security/ip-blacklist/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await db.get('SELECT * FROM ip_blacklists WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ error: '记录不存在' });
    await db.run('DELETE FROM ip_blacklists WHERE id = ?', [id]);
    const { invalidateCache } = require('../middleware/ip-blacklist');
    invalidateCache();
    await audit.log({
      userId: req.user.id,
      username: req.user.username,
      action: 'delete',
      resourceType: 'ip_blacklist',
      resourceId: id,
      resourceName: existing.ip,
      oldValue: existing,
      req
    });
    res.json({ success: true });
  } catch (e) {
    console.error('[Admin] failed to delete IP blacklist:', e.message);
    res.status(500).json({ error: '删除失败' });
  }
});

const DEFAULT_NODE_SECURITY = {
  ipRateLimit: { enabled: false, windowSeconds: 60, maxRequests: 100 },
  bodyLimitMb: 10,
  corsOrigins: '',
  requestTimeoutSeconds: 130,
};

function normalizeNodeSecurity(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : (value || {});
    return {
      ipRateLimit: {
        enabled: parsed.ipRateLimit?.enabled === true,
        windowSeconds: Math.max(1, parseInt(parsed.ipRateLimit?.windowSeconds, 10) || 60),
        maxRequests: Math.max(1, parseInt(parsed.ipRateLimit?.maxRequests, 10) || 100),
      },
      bodyLimitMb: Math.max(1, parseInt(parsed.bodyLimitMb, 10) || 10),
      corsOrigins: typeof parsed.corsOrigins === 'string' ? parsed.corsOrigins : '',
      requestTimeoutSeconds: Math.max(1, parseInt(parsed.requestTimeoutSeconds, 10) || 130),
    };
  } catch (e) {
    return DEFAULT_NODE_SECURITY;
  }
}

/**
 * @swagger
 * /admin/security/node-config:
 *   get:
 *     summary: Get Node.js layer security configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Node security config
 */
router.get('/security/node-config', async (req, res) => {
  try {
    const row = await db.get("SELECT value FROM settings WHERE key = 'node_security'");
    const config = normalizeNodeSecurity(row?.value);
    res.json(config);
  } catch (e) {
    console.error('[Admin] failed to read node security config:', e.message);
    res.status(500).json({ error: '读取失败' });
  }
});

/**
 * @swagger
 * /admin/security/node-config:
 *   put:
 *     summary: Update Node.js layer security configuration
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 */
router.put('/security/node-config', async (req, res) => {
  try {
    const config = normalizeNodeSecurity(req.body);
    await db.run(
      `INSERT INTO settings (key, value) VALUES ('node_security', ?)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(config)]
    );
    res.json({ success: true, config });
  } catch (e) {
    console.error('[Admin] failed to save node security config:', e.message);
    res.status(500).json({ error: '保存失败' });
  }
});

const net = require('net');
const axios = require('axios');

function parseGatewayUrls(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function isPortListening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

async function probeGatewayUrl(url) {
  try {
    const parsed = new URL(url);
    const probeUrl = `${parsed.origin}/health`;
    const res = await axios.get(probeUrl, { timeout: 3000, validateStatus: () => true });
    return { ok: res.status === 200, status: res.status };
  } catch (err) {
    return { ok: false, status: null, error: err.message };
  }
}

async function probeApiEndpoint(url) {
  try {
    const parsed = new URL(url);
    const probeUrl = `${parsed.origin}/v1/models`;
    const start = Date.now();
    const res = await axios.get(probeUrl, { timeout: 5000, validateStatus: () => true });
    return {
      ok: res.status === 200,
      status: res.status,
      latencyMs: Date.now() - start
    };
  } catch (err) {
    return { ok: false, status: null, latencyMs: null, error: err.message };
  }
}

/**
 * @swagger
 * /admin/gateway-status:
 *   get:
 *     summary: Probe gateway URLs and Nginx listen ports
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Gateway and Nginx status
 */
router.get('/gateway-status', async (req, res) => {
  try {
    const settingsRow = await db.get("SELECT value FROM settings WHERE key = 'gateway_urls'");
    const gatewayUrls = parseGatewayUrls(settingsRow?.value);

    let serverCfg = {};
    try {
      serverCfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
    } catch (err) {
      // ignore missing server config
    }
    const nginxPorts = [];
    if (serverCfg?.nginx?.user_listen) nginxPorts.push({ label: 'Nginx 用户入口', port: serverCfg.nginx.user_listen });
    if (serverCfg?.nginx?.admin_listen) nginxPorts.push({ label: 'Nginx 管理入口', port: serverCfg.nginx.admin_listen });

    const urlResults = await Promise.all(gatewayUrls.map(async (u) => {
      if (u.active === false) {
        return { ...u, ok: false, status: null, skipped: true, error: '已禁用' };
      }
      const [probe, apiProbe] = await Promise.all([
        probeGatewayUrl(u.url),
        probeApiEndpoint(u.url)
      ]);
      return { ...u, ...probe, apiStatus: apiProbe };
    }));

    const portResults = await Promise.all(nginxPorts.map(async (p) => {
      const listening = await isPortListening(p.port);
      return { ...p, listening };
    }));

    res.json({
      urls: urlResults,
      nginxPorts: portResults,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[Admin] failed to probe gateway status:', e.message);
    res.status(500).json({ error: '检测失败' });
  }
});

module.exports = router;
