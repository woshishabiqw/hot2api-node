const { execSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.resolve(__dirname, '..', 'backend', '.env') });

const { Select } = require('enquirer');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ECOSYSTEM = path.join(PROJECT_ROOT, 'ecosystem.config.js');
const BACKUP_DIR = path.join(PROJECT_ROOT, 'backups');
const SERVER_CONFIG = path.join(PROJECT_ROOT, 'config', 'server.json');

let BACKEND_PORTS = [];

try {
  const cfg = JSON.parse(fs.readFileSync(SERVER_CONFIG, 'utf8'));
  BACKEND_PORTS = [cfg.ports.api, cfg.ports.admin, cfg.ports.user];
} catch (e) {
  console.error('读取 config/server.json 失败，使用默认端口', e.message);
  BACKEND_PORTS = [3000, 3001, 3002];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: PROJECT_ROOT, ...opts });
}

function shSilent(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'ignore'], ...opts });
  } catch (e) {
    return '';
  }
}

function getPortListeners() {
  const map = {};
  try {
    if (process.platform === 'win32') {
      const out = sh('netstat -ano', { maxBuffer: 10 * 1024 * 1024 });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m) {
          const port = parseInt(m[1], 10);
          map[port] = parseInt(m[2], 10);
        }
      }
    } else {
      // ss -tlnp output: LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=1234,fd=19))
      const out = sh('ss -tlnp', { maxBuffer: 10 * 1024 * 1024 });
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/LISTEN\s+\S+\s+\S+\s+\S+:(\d+)\s+\S+\s+.*pid=(\d+)/i);
        if (m) {
          const port = parseInt(m[1], 10);
          map[port] = parseInt(m[2], 10);
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return map;
}

function getProcInfo(pid) {
  if (!pid) return '';
  try {
    if (process.platform === 'win32') {
      return sh(`wmic process where "ProcessId=${pid}" get Name,CommandLine /format:csv`, { timeout: 5000 });
    }
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function isProjectNode(pid) {
  const info = getProcInfo(pid);
  if (process.platform === 'win32') {
    return info.includes('node.exe') && info.includes('src\\index.js') && info.includes(PROJECT_ROOT);
  }
  return info.includes('node') && info.includes('src/index.js') && info.includes(PROJECT_ROOT);
}

function killPid(pid) {
  try {
    if (process.platform === 'win32') {
      sh(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    return true;
  } catch {
    return false;
  }
}

function getPm2List() {
  try {
    const out = sh('pm2 jlist', { maxBuffer: 50 * 1024 * 1024 });
    const idx = out.indexOf('[');
    if (idx === -1) return [];
    return JSON.parse(out.slice(idx));
  } catch (e) {
    return [];
  }
}

function getServiceStatus() {
  const list = getPm2List();
  const backend = list.find(p => p.name === 'gateway-backend');
  return {
    backend: backend ? backend.pm2_env.status : '未注册',
    backendPid: backend ? backend.pid : null,
  };
}

function printStatus() {
  const ports = getPortListeners();
  const svc = getServiceStatus();
  console.log('\n=== 服务状态 ===');
  console.log(`gateway-backend PM2: ${svc.backend}  PID: ${svc.backendPid || '-'}`);
  console.log('\n端口监听:');
  BACKEND_PORTS.forEach(port => {
    const pid = ports[port];
    console.log(`  :${port}  ${pid ? `PID ${pid}` : '未监听'}`);
  });
  console.log('');
}

async function autoDetectStart() {
  const svc = getServiceStatus();
  const ports = getPortListeners();

  console.log('\n开始自动检测...');
  console.log(`gateway-backend: ${svc.backend}`);

  // 后端孤儿进程清理
  if (svc.backend !== 'online') {
    for (const port of BACKEND_PORTS) {
      const pid = ports[port];
      if (!pid) continue;
      if (isProjectNode(pid)) {
        console.log(`端口 ${port} 被遗留后端进程 (PID ${pid}) 占用，正在清理...`);
        killPid(pid);
        await sleep(500);
      } else {
        console.log(`❌ 端口 ${port} 被外部进程 (PID ${pid}) 占用，无法自动启动后端`);
        return;
      }
    }
  }

  // 启动缺失的服务
  if (svc.backend === '未注册') {
    console.log('启动全部服务...');
    sh('pm2 start ecosystem.config.js', { stdio: 'inherit' });
  } else if (svc.backend !== 'online') {
    console.log('重启 gateway-backend...');
    sh('pm2 restart gateway-backend', { stdio: 'inherit' });
  }

  await sleep(1500);
  printStatus();
  console.log('✅ 自动处理完成\n');
}

function startAll() {
  sh('pm2 start ecosystem.config.js', { stdio: 'inherit' });
}

function stopAll() {
  sh('pm2 stop ecosystem.config.js', { stdio: 'inherit' });
}

function restartAll() {
  sh('pm2 restart ecosystem.config.js', { stdio: 'inherit' });
}

async function viewLogs() {
  const choice = await new Select({
    name: 'service',
    message: '选择要查看日志的服务',
    choices: ['gateway-backend', '返回'],
  }).run();

  if (choice === '返回') return;
  console.log(`正在打开 ${choice} 日志，按 Ctrl+C 退出日志返回菜单...`);
  try {
    sh(`pm2 logs ${choice} --lines 100`, { stdio: 'inherit' });
  } catch {
    // 用户按 Ctrl+C 会抛出，正常返回菜单
  }
}

function httpRequest(method, urlPath, bodyObj, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://localhost:${BACKEND_PORTS[1]}`);
    const postData = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...headers,
      },
      timeout: 8000,
    };
    const req = http.request(options, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

async function healthCheck() {
  console.log('\n=== 健康自检 ===');
  const ports = getPortListeners();
  let ok = true;

  for (const port of BACKEND_PORTS) {
    if (ports[port]) console.log(`✅ 后端端口 ${port} 已监听`);
    else { console.log(`❌ 后端端口 ${port} 未监听`); ok = false; }
  }

  // 登录检测
  let token = null;
  const checkUsername = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
  const checkPassword = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!checkPassword) {
    console.log('⚠️ 未配置 DEFAULT_ADMIN_PASSWORD，跳过管理员登录检测');
  } else {
    try {
      const login = await httpRequest('POST', '/api/auth/login', { username: checkUsername, password: checkPassword });
      if (login.status === 200) {
        const json = JSON.parse(login.body);
        token = json.token;
        console.log('✅ 管理员登录正常');
      } else {
        console.log(`❌ 管理员登录失败: HTTP ${login.status}`);
        ok = false;
      }
    } catch (e) {
      console.log('❌ 管理员登录异常:', e.message);
      ok = false;
    }
  }

  // SSE 检测
  if (token) {
    try {
      await new Promise((resolve, reject) => {
        const url = new URL('/api/admin/sources/probe/stream', `http://localhost:${BACKEND_PORTS[1]}`);
        url.searchParams.set('token', token);
        const req = http.get(url, { timeout: 8000 }, res => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          let buf = '';
          const timer = setTimeout(() => { req.destroy(); reject(new Error('SSE 超时未收到数据')); }, 5000);
          res.on('data', chunk => {
            buf += chunk.toString();
            if (buf.includes('\n\n')) {
              clearTimeout(timer);
              res.destroy();
              resolve();
            }
          });
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('SSE 连接超时')); });
      });
      console.log('✅ SSE 实时流正常');
    } catch (e) {
      console.log('❌ SSE 实时流异常:', e.message);
      ok = false;
    }
  }

  console.log(ok ? '\n✅ 健康检查通过\n' : '\n⚠️ 健康检查存在异常\n');
}

function getDb() {
  return require(path.join(PROJECT_ROOT, 'backend', 'src', 'config', 'database'));
}

async function backupSources() {
  const db = getDb();
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const rows = await db.all('SELECT * FROM sources ORDER BY id');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(BACKUP_DIR, `sources-${ts}.json`);
    fs.writeFileSync(file, JSON.stringify(rows, null, 2), 'utf8');
    console.log(`✅ 已备份 ${rows.length} 条源站记录到 ${file}\n`);
  } catch (e) {
    console.error('备份失败:', e.message);
  } finally {
    process.exit(0);
  }
}

async function restoreSources() {
  const db = getDb();
  try {
    if (!fs.existsSync(BACKUP_DIR)) {
      console.log('没有找到 backups 目录');
      return;
    }
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('sources-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (files.length === 0) {
      console.log('backups 目录下没有源站备份');
      return;
    }

    const choice = await new Select({
      name: 'file',
      message: '选择要恢复的备份',
      choices: [...files, '返回'],
    }).run();
    if (choice === '返回') return;

    const data = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, choice), 'utf8'));
    if (!Array.isArray(data) || data.length === 0) {
      console.log('备份文件为空');
      return;
    }

    const existing = await db.all('SELECT id FROM sources LIMIT 1');
    if (existing.length > 0) {
      console.log('⚠️ sources 表已有数据，恢复会跳过已存在的 name。');
    }

    let inserted = 0;
    let skipped = 0;
    for (const row of data) {
      const dup = await db.get('SELECT id FROM sources WHERE name = $1', [row.name]);
      if (dup) {
        skipped++;
        continue;
      }
      const { id, created_at, ...rest } = row;
      const columns = Object.keys(rest);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
      const values = columns.map(c => rest[c]);
      await db.run(
        `INSERT INTO sources (${columns.join(',')}) VALUES (${placeholders})`,
        values
      );
      inserted++;
    }
    console.log(`✅ 恢复完成：插入 ${inserted} 条，跳过 ${skipped} 条\n`);
  } catch (e) {
    console.error('恢复失败:', e.message);
  } finally {
    process.exit(0);
  }
}

async function runTests() {
  console.log('\n⚠️ 警告：后端测试会 TRUNCATE 真实数据库（源站、用户等数据会被清空）！');
  const confirm = await new Select({
    name: 'confirm',
    message: '确定要运行吗？',
    choices: ['取消', '运行全部测试'],
  }).run();

  if (confirm === '取消') return;
  const pattern = '';
  try {
    const cmd = pattern
      ? `npx jest --runInBand --forceExit --testPathPatterns='${pattern}'`
      : 'npx jest --runInBand --forceExit';
    sh(cmd, { cwd: path.join(PROJECT_ROOT, 'backend'), stdio: 'inherit' });
    console.log('✅ 测试执行完成\n');
  } catch (e) {
    console.log('❌ 测试执行失败或包含未通过用例\n');
  }
}

async function mainMenu() {
  while (true) {
    const action = await new Select({
      name: 'action',
      message: 'AI Key Gateway 全量管理系统',
      choices: [
        '自动检测并启动服务',
        '启动全部服务',
        '停止全部服务',
        '重启全部服务',
        '查看 PM2 状态',
        '查看日志',
        '健康自检',
        '备份源站配置',
        '恢复源站配置',
        '运行后端测试',
        '退出',
      ],
    }).run();

    switch (action) {
      case '自动检测并启动服务':
        await autoDetectStart();
        break;
      case '启动全部服务':
        startAll();
        break;
      case '停止全部服务':
        stopAll();
        break;
      case '重启全部服务':
        restartAll();
        break;
      case '查看 PM2 状态':
        printStatus();
        sh('pm2 list', { stdio: 'inherit' });
        break;
      case '查看日志':
        await viewLogs();
        break;
      case '健康自检':
        await healthCheck();
        break;
      case '备份源站配置':
        await backupSources();
        return;
      case '恢复源站配置':
        await restoreSources();
        return;
      case '运行后端测试':
        await runTests();
        break;
      case '退出':
        console.log('再见');
        return;
    }
  }
}

(async () => {
  try {
    if (process.argv.includes('--auto')) {
      await autoDetectStart();
    } else if (process.argv.includes('--health')) {
      await healthCheck();
    } else if (process.argv.includes('--backup')) {
      await backupSources();
    } else if (process.argv.includes('--restore')) {
      await restoreSources();
    } else {
      await mainMenu();
    }
  } catch (e) {
    console.error('出错了:', e.message);
    process.exit(1);
  }
})();
