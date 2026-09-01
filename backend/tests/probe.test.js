const { describe, it, expect } = require('@jest/globals');

// 必须在加载 probe service 之前 mock 数据库，避免真实初始化
jest.mock('../src/config/database', () => ({
  initDatabase: jest.fn(),
  getApiUrl: jest.fn(),
  getApiKey: jest.fn(),
  run: jest.fn(),
  get: jest.fn(),
  all: jest.fn(),
}));

describe('ProbeService intervals', () => {
  it('unknown 状态探测间隔应为 30 秒（P4 修复）', () => {
    // 每次 require 都拿到新实例，避免单例状态污染
    jest.resetModules();
    const ProbeService = require('../src/services/probe');
    // module.exports = new ProbeService()，所以是实例对象
    expect(ProbeService.intervals.unknown).toBe(30 * 1000);
  });
});
