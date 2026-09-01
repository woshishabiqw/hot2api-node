const { spawn } = require('child_process');
const path = require('path');

let child = null;
let shouldExit = false;
let restartCount = 0;
const MAX_RESTARTS = 100;
const RESTART_DELAY = 3000;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [watcher] ${msg}`);
}

function start() {
  if (shouldExit) return;
  if (restartCount >= MAX_RESTARTS) {
    log('Max restarts reached, giving up.');
    process.exit(1);
  }
  restartCount++;

  log(`Starting backend (restart #${restartCount})...`);

  child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: {
      ...process.env,
      SERVE_FRONTEND: 'true',
      NODE_ENV: 'production'
    }
  });

  child.on('exit', (code, signal) => {
    log(`Backend exited with code ${code}, signal ${signal}`);
    child = null;
    if (!shouldExit) {
      log(`Restarting in ${RESTART_DELAY}ms...`);
      setTimeout(start, RESTART_DELAY);
    }
  });

  child.on('error', (err) => {
    log(`Failed to start backend: ${err.message}`);
    child = null;
    if (!shouldExit) {
      setTimeout(start, RESTART_DELAY);
    }
  });
}

function shutdown(signal) {
  shouldExit = true;
  log(`Received ${signal}, shutting down gracefully...`);
  if (child) {
    child.kill(signal);
    // Force kill after 10s if still alive
    setTimeout(() => {
      if (child) child.kill('SIGKILL');
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Keep the watcher alive
start();
