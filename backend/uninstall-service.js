const path = require('path');
const Service = require('node-windows').Service;

const svc = new Service({
  name: 'FuckGateway',
  script: path.join(__dirname, 'start.js'),
  workingDirectory: __dirname,
});

svc.on('uninstall', () => {
  console.log('[uninstall-service] Service uninstalled');
});

svc.on('error', (err) => {
  console.error('[uninstall-service] Error:', err);
});

console.log('[uninstall-service] Uninstalling service...');
svc.uninstall();
