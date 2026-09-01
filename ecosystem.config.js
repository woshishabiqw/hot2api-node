const path = require('path');

const PROJECT_ROOT = __dirname;
const NODE_EXE = process.platform === 'win32'
  ? path.join(PROJECT_ROOT, 'backend', 'node-v22', 'node.exe')
  : (process.env.NODE_PATH ? path.resolve(process.env.NODE_PATH) : process.execPath);

module.exports = {
  apps: [
    {
      name: 'gateway-backend',
      script: path.join(PROJECT_ROOT, 'backend', 'src', 'index.js'),
      cwd: path.join(PROJECT_ROOT, 'backend'),
      interpreter: NODE_EXE,
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      max_memory_restart: '2G',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      autorestart: true,
    },
  ],
};
