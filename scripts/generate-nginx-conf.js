#!/usr/bin/env node
/**
 * Generate nginx/nginx.conf from nginx/nginx.conf.template
 * Ports are read from config/server.json so Nginx stays in sync with the app.
 */
const fs = require('fs');
const path = require('path');
const { readNginxControl } = require('./nginx-control');

const DEFAULT_ROOT = path.resolve(__dirname, '..');

function buildServerTokens(controlled, security) {
  if (!controlled || !security || security.server_tokens !== true) return '';
  return 'server_tokens off;';
}

function buildSecurityHeadersBlock(controlled, security) {
  if (!controlled || !security || security.security_headers !== true) return '';
  // Only add headers that the Node.js backend (helmet/security middleware) does not already set.
  // helmet sets X-Content-Type-Options, X-Frame-Options and Referrer-Policy; setting them again
  // here produces duplicate/conflicting values. Permissions-Policy is not set by the backend,
  // so we keep it as an nginx-only defense-in-depth header.
  return `add_header Permissions-Policy "geolocation=(), microphone=(), camera=(), payment=(), usb=()" always;`;
}

function buildAdminIpAllowlist(controlled, security) {
  if (!controlled || !security || !Array.isArray(security.admin_ip_allowlist) || security.admin_ip_allowlist.length === 0) {
    return '';
  }
  return security.admin_ip_allowlist.map(cidr => `allow ${cidr};`).join('\n') + '\ndeny all;';
}

function buildRateLimitZone(controlled, capabilities, security) {
  if (!controlled || !capabilities.limit_req || !security || security.rate_limit?.enabled !== true) return '';
  const rps = Number(security.rate_limit.rps) || 10;
  return `limit_req_zone $binary_remote_addr zone=api:10m rate=${rps}r/s;`;
}

function buildRateLimitDirective(controlled, capabilities, security) {
  if (!controlled || !capabilities.limit_req || !security || security.rate_limit?.enabled !== true) return '';
  const burst = Number(security.rate_limit.burst) || 20;
  return `limit_req zone=api burst=${burst} nodelay;`;
}

function buildClientTimeouts(controlled, security) {
  if (!controlled || !security || !security.timeouts) return '';
  const { client_body, client_header, send } = security.timeouts;
  const parts = [];
  if (client_body) parts.push(`client_body_timeout ${client_body}s;`);
  if (client_header) parts.push(`client_header_timeout ${client_header}s;`);
  if (send) parts.push(`send_timeout ${send}s;`);
  return parts.join('\n');
}

function generateNginxConfig(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const configPath = options.configPath || path.join(root, 'config', 'server.json');
  const templatePath = options.templatePath || path.join(root, 'nginx', 'nginx.conf.template');
  const outputPath = options.outputPath || path.join(root, 'nginx', 'nginx.conf');

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const ports = cfg.ports || {};
  const nginxCfg = cfg.nginx || {};
  const security = nginxCfg.security;
  const control = readNginxControl(root);
  const controlled = control.controlled === true;
  const capabilities = control.capabilities || {};

  const vars = {
    API_PORT: ports.api ?? 3000,
    ADMIN_PORT: ports.admin ?? 3001,
    USER_PORT: ports.user ?? 3002,
    NGINX_USER_LISTEN: nginxCfg.user_listen ?? 80,
    NGINX_ADMIN_LISTEN: nginxCfg.admin_listen ?? 81,
    NGINX_SERVER_NAME: nginxCfg.server_name ?? 'localhost',
    SERVER_TOKENS: buildServerTokens(controlled, security),
    SECURITY_HEADERS_BLOCK: buildSecurityHeadersBlock(controlled, security),
    ADMIN_IP_ALLOW_BLOCK: buildAdminIpAllowlist(controlled, security),
    RATE_LIMIT_ZONE: buildRateLimitZone(controlled, capabilities, security),
    RATE_LIMIT_DIRECTIVE: buildRateLimitDirective(controlled, capabilities, security),
    CLIENT_TIMEOUTS: buildClientTimeouts(controlled, security),
  };

  const template = fs.readFileSync(templatePath, 'utf8');
  const output = template.replace(/\$\{([A-Z_]+)\}/g, (_, name) => {
    if (vars[name] === undefined) {
      throw new Error(`Unknown template variable: ${name}`);
    }
    return String(vars[name]);
  });

  fs.writeFileSync(outputPath, output, 'utf8');
  return { outputPath, vars, controlled, capabilities };
}

function main() {
  try {
    const { outputPath, vars } = generateNginxConfig();
    console.log(`[nginx] Generated ${outputPath}`);
    console.log(`[nginx]   API backend   -> 127.0.0.1:${vars.API_PORT}`);
    console.log(`[nginx]   User portal   -> http://${vars.NGINX_SERVER_NAME}:${vars.NGINX_USER_LISTEN}`);
    console.log(`[nginx]   Admin portal  -> http://${vars.NGINX_SERVER_NAME}:${vars.NGINX_ADMIN_LISTEN}`);
  } catch (e) {
    console.error('[nginx] Failed to generate config:', e.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateNginxConfig };
