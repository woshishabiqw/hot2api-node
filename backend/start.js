const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const { loadServerConfig } = require('./src/config/server-config');

const PROJECT_DIR = __dirname;
const NODE_EXE = process.platform === 'win32'
  ? path.join(PROJECT_DIR, 'node-v22', 'node.exe')
  : (process.env.NODE_PATH ? path.resolve(process.env.NODE_PATH) : process.execPath);
const ENTRY = path.join(PROJECT_DIR, 'src', 'index.js');
const PATH_SEP = process.platform === 'win32' ? ';' : ':';
const CHECK_INTERVAL = 10000;
const MAX_RESTARTS = 20;
const serverConfig = loadServerConfig();
const MAX_MEMORY_MB = parseInt(process.env.MAX_MEMORY_MB, 10) || serverConfig.watchdog?.maxMemoryMB || 2048;

let restartCount = 0;
let child = null;
let shuttingDown = false;
let fatalError = false;
let isStarting = false;
const knownChildPids = new Set();

function getLogDir() {
  const dir = path.join(PROJECT_DIR, 'logs');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {}
  return dir;
}

let watchdogLogStream = null;

function openWatchdogLogStream() {
  try {
    watchdogLogStream = fs.createWriteStream(path.join(getLogDir(), 'watchdog.log'), { flags: 'a' });
  } catch (e) {}
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[Watchdog] ${ts} ${msg}`;
  // Do NOT write to the parent terminal. Under high concurrency, multiple node
  // services logging to the same console/ConPTY can crash the terminal window
  // and send SIGHUP to every child process, killing them all at once.
  // Logs are persisted to watchdog.log instead.
  try {
    if (watchdogLogStream) {
      watchdogLogStream.write(line + '\n');
    } else {
      fs.appendFileSync(path.join(getLogDir(), 'watchdog.log'), line + '\n');
    }
  } catch (e) {}
}

function getChildLogPaths() {
  const logDir = getLogDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    out: path.join(logDir, `gateway-out-${ts}.log`),
    err: path.join(logDir, `gateway-err-${ts}.log`)
  };
}

let childLogPaths = null;
let childOutStream = null;
let childErrStream = null;

function closeChildLogStreams() {
  try { childOutStream?.end(); } catch (e) {}
  try { childErrStream?.end(); } catch (e) {}
  childOutStream = null;
  childErrStream = null;
}

function getPortPid(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr ":${port} "`, { encoding: 'utf8', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' });
      const lines = out.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const m = line.match(/LISTENING\s+(\d+)$/i);
        if (m) return parseInt(m[1], 10);
      }
    } else {
      // Linux/macOS: prefer lsof, fallback to ss / fuser
      try {
        const out = execSync(`lsof -i :${port} -sTCP:LISTEN -t -n 2>/dev/null`, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
        const pid = parseInt(out.trim().split(/\r?\n/)[0], 10);
        if (!isNaN(pid)) return pid;
      } catch {}
      try {
        const out = execSync(`ss -tlnp 'sport = :${port}' 2>/dev/null`, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
        const m = out.match(/pid=(\d+)/);
        if (m) return parseInt(m[1], 10);
      } catch {}
      try {
        const out = execSync(`fuser -n tcp ${port} 2>/dev/null`, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
        const pid = parseInt(out.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) return pid;
      } catch {}
    }
  } catch (e) {}
  return null;
}

function runPowerShellFile(script) {
  const tmp = path.join(os.tmpdir(), `gw-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
  try {
    fs.writeFileSync(tmp, script, 'utf8');
    const out = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { encoding: 'utf8', windowsHide: true, timeout: 10000, killSignal: 'SIGKILL' }).trim();
    return out;
  } catch (e) {
    return '';
  } finally {
    try { fs.unlinkSync(tmp); } catch (e) {}
  }
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

function printAccessUrls() {
  const cfg = loadServerConfig();
  const ips = getLocalIPAddresses();
  const apiPort = cfg.ports.api;
  const adminPort = cfg.ports.admin;
  const userPort = cfg.ports.user;
  console.log('');
  console.log('==================================================');
  console.log('   Fuck Gateway - npm start');
  console.log('==================================================');
  console.log('  API access:');
  ips.forEach(ip => console.log(`    http://${ip}:${apiPort}`));
  console.log('  Frontend access:');
  ips.forEach(ip => console.log(`    Admin: http://${ip}:${adminPort}`));
  ips.forEach(ip => console.log(`    User:  http://${ip}:${userPort}`));
  console.log('  Localhost:');
  console.log(`    API:   http://localhost:${apiPort}`);
  console.log(`    Admin: http://localhost:${adminPort}`);
  console.log(`    User:  http://localhost:${userPort}`);
  console.log('==================================================');
}

function getProcessCommandLine(pid) {
  if (process.platform !== 'win32') {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    } catch (e) {}
    return '';
  }
  try {
    // Use Get-CimInstance (modern replacement for Get-WmiObject) via a temp file to avoid quoting hell.
    const script = `try { $p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; if ($p) { $p.CommandLine } } catch { "" }`;
    const out = runPowerShellFile(script);
    if (out) return out;
  } catch (e) {}
  try {
    // Fallback to WMIC on older Windows
    const out = execSync(`wmic process where "processid=${pid}" get commandline /value`, { encoding: 'utf8', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' }).trim();
    if (out) return out;
  } catch (e) {}
  try {
    // Last fallback to tasklist (image name + window title). Use single / options (cmd style).
    const out = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /V`, { encoding: 'utf8', windowsHide: true, timeout: 5000, killSignal: 'SIGKILL' }).trim();
    return out;
  } catch (e) {}
  return '';
}

function isGatewayProcess(pid) {
  // First check our own known child PIDs (most reliable)
  if (knownChildPids.has(pid)) return true;
  const cmd = getProcessCommandLine(pid);
  // Only consider it our gateway if we can prove it from the command line.
  // Do NOT kill arbitrary node.exe processes just because they hold the port.
  if (cmd.includes(PROJECT_DIR) || cmd.includes('ai-key-gateway') || cmd.includes('index.js')) return true;
  // If we could only get the image name (tasklist fallback) and it's a node.exe on one of our
  // dedicated gateway ports, treat it as a stale gateway. This is safe on dev machines where only
  // this gateway binds 3000/3001/3002.
  if (cmd.toLowerCase().includes('node.exe')) return true;
  return false;
}

async function killOldGatewayIfPortInUse(port) {
  let pid = getPortPid(port);
  if (!pid) return true;
  if (!isGatewayProcess(pid)) {
    log(`Port ${port} is in use by external process PID ${pid}. Please stop it manually.`);
    return false;
  }
  log(`Port ${port} is in use by old gateway PID ${pid}. Terminating it...`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /T /F`, { windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (e) {
      // kill may fail if the process is already gone; that's okay if the port is free.
    }
    // Wait progressively longer for the OS to release the socket.
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    const remaining = getPortPid(port);
    if (remaining === null) {
      log(`Port ${port} is now free.`);
      return true;
    }
    if (remaining !== pid) {
      log(`Port ${port} taken by a different PID ${remaining} after kill.`);
      pid = remaining;
    } else {
      log(`Port ${port} still held by PID ${pid} after kill attempt ${attempt}.`);
    }
  }
  log(`Failed to free port ${port} from old gateway PID ${pid} after 3 attempts.`);
  return false;
}

const MAX_CONSOLE_LINES_PER_MINUTE = 300;
let consoleLineCount = 0;
let consoleLineResetTs = 0;
let consoleRateLimitedNotice = false;
let childSpawnTime = 0;
const STARTUP_LOG_WINDOW_MS = 20000; // 前 20 秒输出所有启动日志

function printToConsole(line, isError = false) {
  const now = Date.now();
  if (now - consoleLineResetTs > 60000) {
    consoleLineResetTs = now;
    consoleLineCount = 0;
    consoleRateLimitedNotice = false;
  }
  if (consoleLineCount >= MAX_CONSOLE_LINES_PER_MINUTE) {
    if (!consoleRateLimitedNotice) {
      consoleRateLimitedNotice = true;
      console.log('[Watchdog] Console output rate limit reached, suppressing routine logs. Full logs are still written to backend/logs/gateway-out-*.log');
    }
    return;
  }
  consoleLineCount++;
  if (isError) {
    console.error(line);
  } else {
    console.log(line);
  }
}

function shouldPrintToConsole(line) {
  if (!line) return false;
  // 服务器访问信息、启动参数、ERROR/WARN/FATAL、Probe 关键事件、健康告警、路由/日志状态
  return /^\[(Server|Startup|Probe|Health|WARN|ERROR|FATAL|CORS|Process|SmartRouting|LogManagement)\]/.test(line)
    || /^Gateway is online/.test(line)
    || /EVENT LOOP LAG/.test(line)
    || /\[Probe\] Source .* (recovered|key CHECKING|key INVALID|network ERROR)/.test(line);
}

function isPortListening(port, attempts = 5) {
  return new Promise((resolve) => {
    const http = require('http');
    let tried = 0;

    function tryOnce() {
      tried++;
      const req = http.get(`http://127.0.0.1:${port}/health/live`, (res) => {
        // Any HTTP response means the port is up; we don't care about status code here.
        res.resume();
        resolve(true);
      });
      req.on('error', (err) => {
        if (tried < attempts) {
          setTimeout(tryOnce, 1000);
        } else {
          log(`Health check error on port ${port}: ${err.message}`);
          resolve(false);
        }
      });
      req.setTimeout(10000, () => {
        req.destroy();
        if (tried < attempts) {
          setTimeout(tryOnce, 500);
        } else {
          log(`Health check timeout on port ${port}`);
          resolve(false);
        }
      });
    }

    tryOnce();
  });
}

function sumProcessTreeMemoryBytes(rootPid) {
  if (process.platform !== 'win32') {
    // Linux: use ps to get the whole process tree RSS in one shot.
    try {
      const out = execSync('ps -eo pid,ppid,rss= --no-headers', { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
      const map = new Map();
      const children = new Map();
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 3) continue;
        const pid = parseInt(parts[0], 10);
        const ppid = parseInt(parts[1], 10);
        const rss = parseInt(parts[2], 10) * 1024; // ps rss is in KB
        if (isNaN(pid) || isNaN(rss)) continue;
        map.set(pid, rss);
        if (!children.has(ppid)) children.set(ppid, []);
        children.get(ppid).push(pid);
      }
      let total = 0;
      const stack = [rootPid];
      while (stack.length > 0) {
        const pid = stack.pop();
        const rss = map.get(pid);
        if (rss === undefined) continue;
        total += rss;
        const kids = children.get(pid) || [];
        stack.push(...kids);
      }
      return total;
    } catch (e) {
      return null;
    }
  }

  // Use PowerShell/CIM to get the whole process tree memory in one shot.
  // This avoids both wmic deprecation and tasklist only seeing one PID.
  try {
    const script = '$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize; $procs | ConvertTo-Json -Compress';
    const out = runPowerShellFile(script);
    if (!out) return null;
    const list = JSON.parse(out.replace(/^\uFEFF/, ''));
    if (!Array.isArray(list) || list.length === 0) return null;

    const map = new Map();
    const children = new Map();
    for (const p of list) {
      const pid = p.ProcessId;
      const ppid = p.ParentProcessId;
      const ws = p.WorkingSetSize || 0;
      map.set(pid, ws);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }

    let total = 0;
    const stack = [rootPid];
    while (stack.length > 0) {
      const pid = stack.pop();
      const ws = map.get(pid);
      if (ws === undefined) continue;
      total += ws;
      const kids = children.get(pid) || [];
      stack.push(...kids);
    }
    return total;
  } catch (e) {
    return null;
  }
}

async function getNodeMemoryMB() {
  if (!child || !child.pid) return 0;

  // 1. Prefer process-tree memory via PowerShell/CIM (sum child + descendants).
  const bytes = sumProcessTreeMemoryBytes(child.pid);
  if (bytes !== null) return Math.round(bytes / 1024 / 1024);

  // 2. Fallback to tasklist (Windows) or /proc/status (Linux) for the child PID only.
  try {
    if (process.platform === 'win32') {
      const out = execSync(`tasklist /FI "PID eq ${child.pid}" /FO CSV`, { encoding: 'utf8', windowsHide: true });
      const lines = out.split(/\r?\n/);
      for (const line of lines) {
        if (!line.toLowerCase().includes('node.exe')) continue;
        const parts = line.split('","');
        if (parts[4]) {
          const kb = parseInt(parts[4].replace(/[^\d]/g, ''), 10);
          if (!isNaN(kb)) return Math.round(kb / 1024);
        }
      }
    } else {
      const status = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8');
      const m = status.match(/VmRSS:\s+(\d+)\s+kB/);
      if (m) return Math.round(parseInt(m[1], 10) / 1024);
    }
  } catch (e) {}
  return 0;
}

function isChildAlive() {
  return child && child.exitCode === null && child.signalCode === null;
}

async function startGateway() {
  if (isStarting) {
    log('Gateway startup already in progress, skipping duplicate start.');
    return;
  }
  isStarting = true;

  if (child) {
    log('Stopping existing gateway child...');
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 3000));
    if (isChildAlive()) {
      try { child.kill('SIGKILL'); } catch (e) {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    closeChildLogStreams();
  }

  log('Starting gateway with Node v22...');
  try {
    const ver = execSync(`"${NODE_EXE}" -v`, { encoding: 'utf8', windowsHide: true }).trim();
    log(`Node.js version confirmed: ${ver}`);
  } catch (e) {
    log(`Node.js version check failed: ${e.message}`);
  }

  // Clean up stale gateway on configured ports so we don't get EADDRINUSE.
  // Kill and wait for all three ports before spawning the child to avoid race
  // conditions where the new process tries to bind while the OS is still holding
  // the old socket in TIME_WAIT or the previous child hasn't fully exited.
  for (const port of [serverConfig.ports.api, serverConfig.ports.admin, serverConfig.ports.user]) {
    const killed = await killOldGatewayIfPortInUse(port);
    if (!killed && getPortPid(port)) {
      log(`Cannot free port ${port}. Aborting startup.`);
      fatalError = true;
      return;
    }
  }
  // Extra safety pause: let the OS finish tearing down sockets after taskkill.
  await new Promise((r) => setTimeout(r, 1500));

  // Open log files as writable streams. We still persist everything to disk,
  // but now we also pipe the child output back to the parent console so that
  // `npm start` shows startup info, access URLs and ERROR logs again.
  childLogPaths = getChildLogPaths();
  closeChildLogStreams();
  try {
    childOutStream = fs.createWriteStream(childLogPaths.out, { flags: 'a' });
    childErrStream = fs.createWriteStream(childLogPaths.err, { flags: 'a' });
  } catch (e) {
    log(`Failed to open child log files: ${e.message}`);
  }

  // Increase heap limit and disable transit scanning to reduce CPU/memory
  // pressure and terminal noise during high-concurrency load tests.
  // Add diagnostic flags so Node produces reports on fatal errors / uncaught
  // exceptions, helping us find the real reason when the gateway dies.
  const nodeArgs = [
    '--max-old-space-size=4096',
    '--trace-uncaught',
    '--report-on-fatalerror',
    '--report-on-signal=SIGILL,SIGTRAP,SIGABRT,SIGBUS,SIGFPE,SIGSEGV',
    '--diagnostic-dir=' + path.join(getLogDir(), 'reports'),
    ENTRY
  ];

  // Ensure diagnostic reports directory exists.
  try {
    fs.mkdirSync(path.join(getLogDir(), 'reports'), { recursive: true });
  } catch (e) {}

  child = spawn(NODE_EXE, nodeArgs, {
    cwd: PROJECT_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SERVE_FRONTEND: 'true',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info',
      DISABLE_TRANSIT_SCAN: process.env.DISABLE_TRANSIT_SCAN || '0',
      PATH: process.platform === 'win32'
        ? path.join(PROJECT_DIR, 'node-v22') + PATH_SEP + process.env.PATH
        : process.env.PATH,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  knownChildPids.add(child.pid);

  childSpawnTime = Date.now();

  // Tee child stdout/stderr to log files and (filtered) parent console.
  if (child.stdout) {
    const rlOut = readline.createInterface({ input: child.stdout });
    rlOut.on('line', (line) => {
      try { childOutStream?.write(line + '\n'); } catch (e) {}
      const inStartupWindow = Date.now() - childSpawnTime < STARTUP_LOG_WINDOW_MS;
      if (inStartupWindow || shouldPrintToConsole(line)) printToConsole(line);
    });
  }
  if (child.stderr) {
    const rlErr = readline.createInterface({ input: child.stderr });
    rlErr.on('line', (line) => {
      try { childErrStream?.write(line + '\n'); } catch (e) {}
      printToConsole(line, true);
    });
  }

  const spawnedChild = child;
  spawnedChild.on('exit', (code, signal) => {
    closeChildLogStreams();
    if (code === 4294967295 || code === -1 || code === 255) {
      log(`Gateway exited with abnormal code ${code} (Windows fatal termination / Node crash / OOM / external kill). Check Windows Event Viewer and Node diagnostic reports.`);
    } else {
      log(`Gateway exited with code ${code}, signal ${signal}`);
    }
    if (shuttingDown) return;
    // Only clear the reference if this event belongs to the current child.
    // A previously killed child may emit 'exit' after we have already spawned
    // a replacement, and we must not null out the new child reference.
    if (child === spawnedChild) {
      child = null;
    }
  });

  await new Promise((r) => setTimeout(r, 12000));
  const listening = await isPortListening(serverConfig.ports.api);
  const alive = isChildAlive();
  isStarting = false;
  if (listening && alive) {
    log('Gateway is online.');
  } else {
    log(`Gateway startup check — listening=${listening}, alive=${alive}`);
  }
}

async function monitor() {
  while (!shuttingDown) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL));
    if (shuttingDown) break;

    const listening = await isPortListening(serverConfig.ports.api);
    const alive = isChildAlive();

    if (fatalError) {
      log('Fatal startup error (e.g. port in use by external process). Giving up.');
      closeChildLogStreams();
      process.exit(1);
    }

    if (isStarting) {
      // Give startup sequence time to finish without monitor interference.
      continue;
    }

    if (!listening && alive) {
      log(`WARNING: Gateway process is alive but port ${serverConfig.ports.api} is not responding. Restarting in 30s unless it recovers...`);
      await new Promise((r) => setTimeout(r, 30000));
      const stillBad = !(await isPortListening(serverConfig.ports.api)) && isChildAlive();
      if (stillBad) {
        restartCount++;
        log(`Gateway still unresponsive. Restarting... (#${restartCount}/${MAX_RESTARTS})`);
        await startGateway();
        if (fatalError) {
          log('Fatal startup error after restart attempt. Giving up.');
          closeChildLogStreams();
          process.exit(1);
        }
      }
      continue;
    }

    if (!alive) {
      restartCount++;
      if (restartCount > MAX_RESTARTS) {
        log(`Too many restarts (${MAX_RESTARTS}). Giving up.`);
        closeChildLogStreams();
        process.exit(1);
      }
      log(`Gateway DOWN (process died). Restarting... (#${restartCount}/${MAX_RESTARTS})`);
      await startGateway();
      if (fatalError) {
        log('Fatal startup error after restart attempt. Giving up.');
        closeChildLogStreams();
        process.exit(1);
      }
      continue;
    }

    const memMB = await getNodeMemoryMB();
    if (memMB > MAX_MEMORY_MB) {
      log(`Memory ${memMB}MB > ${MAX_MEMORY_MB}MB. Restarting...`);
      restartCount++;
      await startGateway();
      continue;
    }

    if (restartCount > 0) {
      log(`Gateway is healthy (mem=${memMB}MB). Resetting restart counter.`);
      restartCount = 0;
    }
  }
}

async function shutdown(signal) {
  shuttingDown = true;
  log(`${signal} received, shutting down...`);
  if (child) {
    try { child.kill('SIGTERM'); } catch (e) {}
    await new Promise((r) => setTimeout(r, 3000));
    if (isChildAlive()) {
      try { child.kill('SIGKILL'); } catch (e) {}
    }
  }
  closeChildLogStreams();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Ignore SIGHUP so the watchdog survives terminal/ConPTY crashes on Windows
// and remote shell disconnects on *nix.
process.on('SIGHUP', () => log('SIGHUP received, ignoring (watchdog keeps running).'));
process.on('exit', () => { closeChildLogStreams(); });

(async () => {
  openWatchdogLogStream();
  log('Watchdog started.');
  await startGateway();
  monitor();
})();
