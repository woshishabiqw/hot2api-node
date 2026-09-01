const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

const LOG_DIR = path.join(__dirname, '..', 'logs');
const MONITOR_LOG = path.join(LOG_DIR, `load-monitor-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);

function log(line) {
  const ts = new Date().toISOString();
  const text = `[${ts}] ${line}\n`;
  fs.appendFileSync(MONITOR_LOG, text);
  process.stdout.write(text);
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3000/health/live', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ alive: res.statusCode === 200, status: res.statusCode, body: data.slice(0, 200) }));
    });
    req.on('error', (err) => resolve({ alive: false, status: 0, body: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ alive: false, status: 0, body: 'timeout' }); });
  });
}

async function getNodeProcesses() {
  try {
    const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', { timeout: 5000 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [`tasklist error: ${e.message}`];
  }
}

async function getPorts() {
  try {
    const { stdout } = await execAsync('netstat -ano | findstr "3000 3001 3002"', { timeout: 5000 });
    return stdout.trim().split('\n').filter(Boolean);
  } catch (e) {
    return [`netstat error: ${e.message}`];
  }
}

async function snapshot(label) {
  log(`--- ${label} ---`);
  const health = await checkHealth();
  log(`health: ${JSON.stringify(health)}`);
  const procs = await getNodeProcesses();
  log(`node processes (${procs.length}):`);
  procs.slice(0, 10).forEach(p => log(`  ${p}`));
  const ports = await getPorts();
  log(`ports (${ports.length}):`);
  ports.slice(0, 10).forEach(p => log(`  ${p}`));
}

async function main() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  log('Monitor started');
  await snapshot('initial');

  // Run until stopped
  const interval = setInterval(() => snapshot('periodic'), 5000);

  process.on('SIGINT', () => {
    clearInterval(interval);
    snapshot('final').then(() => process.exit(0));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
