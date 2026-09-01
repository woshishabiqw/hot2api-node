const fs = require('fs');
const path = require('path');
const os = require('os');
const { describe, it, expect, beforeEach, afterEach } = require('@jest/globals');
const {
  isNginxControlled,
  parseCapabilities,
  writeNginxControl,
  readNginxControl,
} = require('../../scripts/nginx-control');

describe('Nginx control detection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-control-test-'));
    fs.mkdirSync(path.join(tmpDir, 'nginx'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('项目 nginx 目录下的二进制视为可控', () => {
    const bin = path.join(tmpDir, 'nginx', 'nginx.exe');
    expect(isNginxControlled(bin, tmpDir)).toBe(true);
  });

  it('系统 Nginx 视为不可控', () => {
    expect(isNginxControlled('/usr/sbin/nginx', tmpDir)).toBe(false);
    expect(isNginxControlled('nginx', tmpDir)).toBe(false);
  });

  it('写入并读取控制文件', () => {
    const bin = path.join(tmpDir, 'nginx', 'nginx.exe');
    const written = writeNginxControl(tmpDir, bin);
    expect(written.controlled).toBe(true);
    expect(written.binary).toBe(bin);
    expect(written.capabilities).toBeDefined();

    const read = readNginxControl(tmpDir);
    expect(read.controlled).toBe(true);
  });

  it('外部 Nginx 写入后 controlled 为 false 且能力为空', () => {
    const written = writeNginxControl(tmpDir, '/usr/sbin/nginx');
    expect(written.controlled).toBe(false);
    expect(Object.keys(written.capabilities)).toHaveLength(0);
  });
});

describe('Nginx capability parsing', () => {
  let tmpDir;
  let fakeBin;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginx-cap-test-'));
    fakeBin = path.join(tmpDir, process.platform === 'win32' ? 'nginx.exe' : 'nginx');
    fs.writeFileSync(fakeBin, '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('解析 nginx -V 输出并禁用缺失模块', () => {
    // Shell-script fake binaries are not executable on Windows; skip there.
    if (process.platform === 'win32') {
      return;
    }
    // Create a fake binary that echoes the configure args.
    const script = '#!/bin/sh\necho "nginx version: fake"\necho "configure arguments: --without-http_limit_req_module --without-http_rewrite_module" >&2';
    fs.writeFileSync(fakeBin, script, { mode: 0o755 });
    fs.chmodSync(fakeBin, 0o755);

    const caps = parseCapabilities(fakeBin);
    expect(caps.limit_req).toBe(false);
    expect(caps.rewrite).toBe(false);
    expect(caps.access).toBe(true);
    expect(caps.headers).toBe(true);
  });
});
