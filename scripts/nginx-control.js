/**
 * Nginx control / capability detection.
 *
 * The project only emits Nginx-level security directives when it is managing
 * the bundled Nginx binary. External Nginx deployments are detected and ignored.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONTROL_FILE = '.nginx-control.json';

function getControlFilePath(rootDir) {
  return path.join(rootDir, 'nginx', CONTROL_FILE);
}

function isNginxControlled(binaryPath, rootDir) {
  if (!binaryPath) return false;
  const resolved = path.resolve(binaryPath);
  const nginxDir = path.join(path.resolve(rootDir), 'nginx');
  return resolved.startsWith(nginxDir + path.sep) || resolved === nginxDir;
}

function parseCapabilities(binaryPath) {
  const capabilities = {
    limit_req: true,
    access: true,
    headers: true,
    rewrite: true,
  };

  try {
    const result = spawnSync(binaryPath, ['-V'], { encoding: 'utf8', windowsHide: true });
    const text = (result.stderr || '') + (result.stdout || '');
    if (text.includes('--without-http_limit_req_module')) capabilities.limit_req = false;
    if (text.includes('--without-http_access_module')) capabilities.access = false;
    if (text.includes('--without-http_headers_filter_module')) capabilities.headers = false;
    if (text.includes('--without-http_rewrite_module')) capabilities.rewrite = false;
  } catch (e) {
    console.warn('[nginx-control] Failed to parse nginx capabilities:', e.message);
  }

  return capabilities;
}

function writeNginxControl(rootDir, binaryPath) {
  const controlled = isNginxControlled(binaryPath, rootDir);
  const payload = {
    controlled,
    binary: binaryPath,
    capabilities: controlled ? parseCapabilities(binaryPath) : {},
    timestamp: new Date().toISOString(),
  };

  const filePath = getControlFilePath(rootDir);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

function readNginxControl(rootDir) {
  const filePath = getControlFilePath(rootDir);
  if (!fs.existsSync(filePath)) {
    return { controlled: false, binary: null, capabilities: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn('[nginx-control] Failed to read control file:', e.message);
    return { controlled: false, binary: null, capabilities: {} };
  }
}

module.exports = {
  isNginxControlled,
  parseCapabilities,
  writeNginxControl,
  readNginxControl,
  getControlFilePath,
};
