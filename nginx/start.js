#!/usr/bin/env node
/**
 * One-command nginx launcher.
 *
 * Usage:
 *   cd nginx
 *   node start.js              # generate config and start nginx
 *   node start.js --stop       # stop nginx
 *   node start.js --reload     # reload nginx config
 *   node start.js --test       # only test config syntax
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const os = require('os');
const { generateNginxConfig } = require('../scripts/generate-nginx-conf');
const { writeNginxControl } = require('../scripts/nginx-control');

const NGINX_DIR = __dirname;
const ROOT_DIR = path.resolve(NGINX_DIR, '..');
const PID_FILE = path.join(NGINX_DIR, 'nginx.pid');

function log(level, ...args) {
  console.log(`[nginx/${level}]`, ...args);
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

function printAccessUrls(vars) {
  const ips = getLocalIPAddresses();
  const serverName = vars.NGINX_SERVER_NAME || 'localhost';
  const userPort = vars.NGINX_USER_LISTEN || 3003;
  const adminPort = vars.NGINX_ADMIN_LISTEN || 3004;
  const ipUserLines = ips.map(ip => `    User:  http://${ip}:${userPort}`).join('\n');
  const ipAdminLines = ips.map(ip => `    Admin: http://${ip}:${adminPort}`).join('\n');
  console.log('');
  console.log('==================================================');
  console.log('   Fuck Gateway - Nginx Proxy');
  console.log('==================================================');
  console.log('  Access URLs (LAN):');
  console.log(ipUserLines);
  console.log(ipAdminLines);
  console.log('  Localhost:');
  console.log(`    User:  http://${serverName}:${userPort}`);
  console.log(`    Admin: http://${serverName}:${adminPort}`);
  console.log('==================================================');
}

function getPlatformBinary() {
  if (process.platform === 'win32') {
    return path.join(NGINX_DIR, 'nginx.exe');
  }
  // Linux: prefer static build, then Alpine musl binary, then system nginx
  const candidates = [
    path.join(NGINX_DIR, 'linux', 'bin', 'nginx-static'),
    path.join(NGINX_DIR, 'linux', 'bin', 'nginx'),
    '/usr/sbin/nginx',
    '/usr/local/bin/nginx',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'nginx';
}

function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runNginx(bin, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      cwd: NGINX_DIR,
      stdio: 'inherit',
      detached: false,
      windowsHide: true,
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`nginx exited with code ${code}`));
    });
  });
}

async function checkPort(port) {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EACCES') resolve('denied');
      else if (err.code === 'EADDRINUSE') resolve('inuse');
      else resolve('error');
    });
    server.once('listening', () => {
      server.close();
      resolve('available');
    });
    server.listen(port, '0.0.0.0');
  });
}

async function testBackendPorts(configPath) {
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const ports = cfg.ports || {};
  const nginxCfg = cfg.nginx || {};
  const http = require('http');

  const checkHttp = (port) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

  const apiOk = await checkHttp(ports.api || 3000);
  const adminOk = await checkHttp(ports.admin || 3001);
  const userOk = await checkHttp(ports.user || 3002);

  if (!apiOk) log('warn', `Backend API not responding on port ${ports.api || 3000}. Start it first: npm run start:all`);
  if (!adminOk) log('warn', `Admin frontend not responding on port ${ports.admin || 3001}`);
  if (!userOk) log('warn', `User frontend not responding on port ${ports.user || 3002}`);

  // Check nginx listen ports before attempting to bind
  const userPort = nginxCfg.user_listen || 80;
  const adminPort = nginxCfg.admin_listen || 81;
  const userStatus = await checkPort(userPort);
  const adminStatus = await checkPort(adminPort);

  if (userStatus === 'denied' || adminStatus === 'denied') {
    log('warn', `Ports ${userPort}/${adminPort} require admin/root privileges on this system.`);
    log('warn', `To avoid this, edit config/server.json and set nginx.user_listen / nginx.admin_listen to values >= 1024, then run again.`);
  }

  return apiOk;
}

async function main() {
  const args = process.argv.slice(2);
  const action = args.find(a => a.startsWith('--')) || '--start';

  const bin = getPlatformBinary();
  log('info', `Using nginx binary: ${bin}`);
  const control = writeNginxControl(ROOT_DIR, bin);
  log('info', `Nginx controlled: ${control.controlled}`);

  if (action === '--stop') {
    if (!isRunning()) {
      log('info', 'nginx is not running');
      return;
    }
    log('info', 'Stopping nginx...');
    execFileSync(bin, ['-s', 'stop', '-c', 'nginx.conf'], { cwd: NGINX_DIR, stdio: 'inherit' });
    log('info', 'Stopped');
    return;
  }

  if (action === '--reload') {
    if (!isRunning()) {
      log('warn', 'nginx is not running, starting instead...');
    } else {
      log('info', 'Reloading nginx config...');
      execFileSync(bin, ['-s', 'reload', '-c', 'nginx.conf'], { cwd: NGINX_DIR, stdio: 'inherit' });
      log('info', 'Reloaded');
      return;
    }
  }

  if (action === '--test') {
    log('info', 'Generating config...');
    generateNginxConfig({ root: ROOT_DIR });
    log('info', 'Checking ports...');
    await testBackendPorts(path.join(ROOT_DIR, 'config', 'server.json'));
    log('info', 'Testing config...');
    execFileSync(bin, ['-t', '-c', 'nginx.conf'], { cwd: NGINX_DIR, stdio: 'inherit' });
    return;
  }

  // --start (default)
  log('info', 'Generating nginx.conf from config/server.json...');
  const result = generateNginxConfig({ root: ROOT_DIR });

  log('info', 'Checking backend services...');
  await testBackendPorts(path.join(ROOT_DIR, 'config', 'server.json'));

  const { vars } = result;
  if (isRunning()) {
    log('info', 'nginx already running, reloading config...');
    execFileSync(bin, ['-s', 'reload', '-c', 'nginx.conf'], { cwd: NGINX_DIR, stdio: 'inherit' });
    log('info', 'Reloaded');
    printAccessUrls(vars);
  } else {
    log('info', 'Starting nginx...');
    printAccessUrls(vars);
    await runNginx(bin, ['-c', 'nginx.conf']);
  }
}

main().catch((err) => {
  console.error('[nginx/error]', err.message);
  process.exit(1);
});
