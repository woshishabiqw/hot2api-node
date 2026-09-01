const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const { generateNginxConfig } = require('../../scripts/generate-nginx-conf');

describe('Nginx config generator', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('从 server.json 读取端口并生成正确配置', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ports: { api: 4000, admin: 4001, user: 4002 },
        nginx: { user_listen: 8080, admin_listen: 8081, server_name: 'gateway.local' },
      })
    );

    fs.writeFileSync(
      templatePath,
      'upstream api { server 127.0.0.1:${API_PORT}; }\n' +
        'listen ${NGINX_USER_LISTEN};\n' +
        'server_name ${NGINX_SERVER_NAME};\n'
    );

    const result = generateNginxConfig({ configPath, templatePath, outputPath });

    expect(result.vars.API_PORT).toBe(4000);
    expect(result.vars.ADMIN_PORT).toBe(4001);
    expect(result.vars.USER_PORT).toBe(4002);
    expect(result.vars.NGINX_USER_LISTEN).toBe(8080);
    expect(result.vars.NGINX_ADMIN_LISTEN).toBe(8081);
    expect(result.vars.NGINX_SERVER_NAME).toBe('gateway.local');

    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('server 127.0.0.1:4000');
    expect(output).toContain('listen 8080;');
    expect(output).toContain('server_name gateway.local;');
    expect(output).not.toContain('${');
  });

  it('缺少模板变量时抛出错误', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(configPath, JSON.stringify({ ports: {} }));
    fs.writeFileSync(templatePath, 'listen ${UNKNOWN_VAR};');

    expect(() => generateNginxConfig({ configPath, templatePath, outputPath })).toThrow('Unknown template variable');
  });

  it('使用默认值当 server.json 缺少 nginx 段', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(configPath, JSON.stringify({ ports: { api: 3000, admin: 3001, user: 3002 } }));
    fs.writeFileSync(templatePath, 'listen ${NGINX_USER_LISTEN}; server_name ${NGINX_SERVER_NAME};');

    const result = generateNginxConfig({ configPath, templatePath, outputPath });
    expect(result.vars.NGINX_USER_LISTEN).toBe(80);
    expect(result.vars.NGINX_SERVER_NAME).toBe('localhost');
  });

  it('可控 Nginx 且开启安全选项时生成对应指令', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ports: { api: 3000, admin: 3001, user: 3002 },
        nginx: {
          user_listen: 3003,
          admin_listen: 3004,
          server_name: 'localhost',
          security: {
            server_tokens: true,
            security_headers: true,
            admin_ip_allowlist: ['127.0.0.1/32', '10.0.0.0/24'],
            rate_limit: { enabled: true, rps: 15, burst: 30 },
            timeouts: { client_body: 45, client_header: 45, send: 45 },
          },
        },
      })
    );

    fs.writeFileSync(
      templatePath,
      '${SERVER_TOKENS}\n${CLIENT_TIMEOUTS}\n${RATE_LIMIT_ZONE}\nserver { ${SECURITY_HEADERS_BLOCK}\n${ADMIN_IP_ALLOW_BLOCK}\nlocation /v1/ { ${RATE_LIMIT_DIRECTIVE}\n}\n}\n'
    );

    // Simulate project-controlled Nginx with full module support.
    fs.mkdirSync(path.join(tmpDir, 'nginx'));
    fs.writeFileSync(
      path.join(tmpDir, 'nginx', '.nginx-control.json'),
      JSON.stringify({ controlled: true, capabilities: { limit_req: true, access: true, headers: true } })
    );

    const result = generateNginxConfig({ root: tmpDir, configPath, templatePath, outputPath });
    expect(result.controlled).toBe(true);

    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('server_tokens off;');
    expect(output).toContain('client_body_timeout 45s;');
    expect(output).toContain('limit_req_zone $binary_remote_addr zone=api:10m rate=15r/s;');
    expect(output).toContain('add_header Permissions-Policy');
    expect(output).toContain('allow 127.0.0.1/32;');
    expect(output).toContain('deny all;');
    expect(output).toContain('limit_req zone=api burst=30 nodelay;');
  });

  it('外部 Nginx 不生成任何安全指令', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ports: { api: 3000, admin: 3001, user: 3002 },
        nginx: {
          user_listen: 3003,
          admin_listen: 3004,
          server_name: 'localhost',
          security: {
            server_tokens: true,
            security_headers: true,
            admin_ip_allowlist: ['127.0.0.1/32'],
            rate_limit: { enabled: true, rps: 10, burst: 20 },
          },
        },
      })
    );

    fs.writeFileSync(
      templatePath,
      '${SERVER_TOKENS}\n${SECURITY_HEADERS_BLOCK}\n${ADMIN_IP_ALLOW_BLOCK}\n${RATE_LIMIT_ZONE}\n${RATE_LIMIT_DIRECTIVE}\n'
    );

    fs.mkdirSync(path.join(tmpDir, 'nginx'));
    fs.writeFileSync(
      path.join(tmpDir, 'nginx', '.nginx-control.json'),
      JSON.stringify({ controlled: false, capabilities: {} })
    );

    const result = generateNginxConfig({ root: tmpDir, configPath, templatePath, outputPath });
    expect(result.controlled).toBe(false);

    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).not.toContain('server_tokens');
    expect(output).not.toContain('add_header');
    expect(output).not.toContain('allow 127.0.0.1');
    expect(output).not.toContain('limit_req');
  });

  it('Nginx 不支持 limit_req 时跳过限速指令', () => {
    const configPath = path.join(tmpDir, 'server.json');
    const templatePath = path.join(tmpDir, 'nginx.conf.template');
    const outputPath = path.join(tmpDir, 'nginx.conf');

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        ports: { api: 3000, admin: 3001, user: 3002 },
        nginx: {
          user_listen: 3003,
          admin_listen: 3004,
          server_name: 'localhost',
          security: {
            server_tokens: true,
            rate_limit: { enabled: true, rps: 10, burst: 20 },
          },
        },
      })
    );

    fs.writeFileSync(
      templatePath,
      '${SERVER_TOKENS}\n${RATE_LIMIT_ZONE}\n${RATE_LIMIT_DIRECTIVE}\n'
    );

    fs.mkdirSync(path.join(tmpDir, 'nginx'));
    fs.writeFileSync(
      path.join(tmpDir, 'nginx', '.nginx-control.json'),
      JSON.stringify({ controlled: true, capabilities: { limit_req: false } })
    );

    generateNginxConfig({ root: tmpDir, configPath, templatePath, outputPath });

    const output = fs.readFileSync(outputPath, 'utf8');
    expect(output).toContain('server_tokens off;');
    expect(output).not.toContain('limit_req');
  });
});
