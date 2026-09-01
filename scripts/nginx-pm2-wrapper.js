const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { writeNginxControl } = require('./nginx-control');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const NGINX_DIR = path.join(PROJECT_ROOT, 'nginx');
const CONF = 'nginx.conf';

function getLinuxNginxBinary() {
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

const NGINX_EXE = process.platform === 'win32'
  ? path.join(NGINX_DIR, 'nginx.exe')
  : getLinuxNginxBinary();

// Mark Nginx as project-controlled because this wrapper always uses the bundled binary.
writeNginxControl(PROJECT_ROOT, NGINX_EXE);

function runNginx(args, stdio = 'ignore') {
  return spawn(NGINX_EXE, args, {
    cwd: NGINX_DIR,
    stdio,
    windowsHide: true,
  });
}

function stopNginx(done) {
  const p = runNginx(['-s', 'quit', '-c', CONF]);
  p.on('exit', () => {
    // Give nginx a moment to release ports
    setTimeout(() => done && done(), 500);
  });
  p.on('error', () => {
    setTimeout(() => done && done(), 500);
  });
}

function startNginx() {
  // Try to stop any stale instance using the same config first
  stopNginx(() => {
    const child = runNginx(['-c', CONF], 'inherit');
    child.on('exit', (code) => {
      process.exit(code == null ? 0 : code);
    });
    child.on('error', (err) => {
      console.error('[nginx-pm2] failed to start nginx:', err.message);
      process.exit(1);
    });
  });
}

function gracefulShutdown() {
  stopNginx(() => process.exit(0));
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('message', (msg) => {
  if (msg === 'shutdown') gracefulShutdown();
});

startNginx();
