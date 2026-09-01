const axios = require('axios');
const { describe, it, expect, beforeAll, afterAll } = require('@jest/globals');
const {
  initTestDatabase,
  cleanDatabase,
  getDb,
} = require('./utils');
const keyChecker = require('../src/services/key-checker');

describe('KeyChecker', () => {
  beforeAll(async () => {
    await initTestDatabase();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await cleanDatabase();
  });

  async function createOpenAISource() {
    const db = getDb();
    const encryptedKey = db.encrypt('sk-testkey');
    const result = await db.run(
      `INSERT INTO sources (name, base_url, protocol, api_key, is_active, weight, max_concurrent, quota_limit)
       VALUES (?, 'http://localhost:19999', 'openai', ?, true, 1, 1000000, 1000000)`,
      [`KeyCheck Source ${Date.now()}`, encryptedKey]
    );
    const sourceId = result.lastInsertRowid;

    await db.run(
      `INSERT INTO models (source_id, model_id, source_model_id, is_active)
       VALUES (?, 'test-model', 'test-model', true)`,
      [sourceId]
    );

    return sourceId;
  }

  it('429 engine_overloaded_error 应标记源站为 unavailable', async () => {
    const sourceId = await createOpenAISource();

    const postSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      status: 429,
      data: {
        error: {
          message: 'The engine is currently overloaded, please try again later',
          type: 'engine_overloaded_error',
        },
      },
    });

    try {
      const result = await keyChecker.checkSource(sourceId);
      expect(result.status).toBe('unavailable');
      expect(result.error).toMatch(/暂时过载/);

      const db = getDb();
      const source = await db.get('SELECT status, last_check_status_code, last_check_detail FROM sources WHERE id = ?', [sourceId]);
      expect(source.status).toBe('unavailable');
      expect(source.last_check_status_code).toBe(429);
      expect(source.last_check_detail).toContain('暂时过载');
    } finally {
      postSpy.mockRestore();
    }
  });

  it('402 应标记源站为 insufficient', async () => {
    const sourceId = await createOpenAISource();

    const postSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      status: 402,
      data: { error: { message: 'Insufficient balance' } },
    });

    try {
      const result = await keyChecker.checkSource(sourceId);
      expect(result.status).toBe('insufficient');

      const db = getDb();
      const source = await db.get('SELECT status, last_check_status_code, last_check_detail FROM sources WHERE id = ?', [sourceId]);
      expect(source.status).toBe('insufficient');
      expect(source.last_check_status_code).toBe(402);
      expect(source.last_check_detail).toContain('Insufficient balance');
    } finally {
      postSpy.mockRestore();
    }
  });

  it('200 应标记源站为 valid', async () => {
    const sourceId = await createOpenAISource();

    const postSpy = jest.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        id: 'chatcmpl-test',
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    });

    try {
      const result = await keyChecker.checkSource(sourceId);
      expect(result.status).toBe('valid');

      const db = getDb();
      const source = await db.get('SELECT status, last_check_status_code, last_check_detail FROM sources WHERE id = ?', [sourceId]);
      expect(source.status).toBe('valid');
      expect(source.last_check_status_code).toBe(200);
      expect(source.last_check_detail).toContain('正常');
    } finally {
      postSpy.mockRestore();
    }
  });
});
