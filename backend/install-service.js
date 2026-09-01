const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'FuckGateway',
  description: 'AI Key Gateway - API Proxy with Token Tracking',
  script: path.join(__dirname, 'start.js'),
  workingDirectory: __dirname,
  execPath: path.join(__dirname, 'node-v22', 'node.exe'),
  env: [
    { name: 'NODE_ENV', value: 'production' },
    { name: 'SERVE_FRONTEND', value: 'true' },
    { name: 'LOG_LEVEL', value: 'info' },
  ],
  logOnAs: {
    account: 'LocalSystem',
    password: ''
  },
  allowServiceLogon: false,
  maxRestarts: 3,
  restartWaitTime: 30,
  abortOnError: false,
});

svc.on('install', () => {
  console.log('[install-service] Service installed, starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('[install-service] Service already installed, starting...');
  svc.start();
});

svc.on('start', () => {
  console.log('[install-service] Service started');
});

svc.on('error', (err) => {
  console.error('[install-service] Error:', err);
});

console.log('[install-service] Installing service...');
svc.install();
