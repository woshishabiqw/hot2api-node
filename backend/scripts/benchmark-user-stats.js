/**
 * 临时性能测试脚本：/user/stats
 * 用法：
 *   cd backend
 *   node scripts/benchmark-user-stats.js
 *
 * 环境变量：
 *   LOG_COUNT=100000        # 插入多少条测试日志
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');

async function main() {
  // 清掉模块缓存，让 database 重新初始化
  Object.keys(require.cache).forEach((key) => {
    if (key.includes('/src/config/database') || key.includes('/src/config/db/')) {
      delete require.cache[key];
    }
  });

  const db = require('../src/config/database');
  await db.initDatabase();

  // 清理并创建测试用户
  const passwordHash = bcrypt.hashSync('test123', 10);
  const username = `benchmark_user_${Date.now()}`;
  try {
    await db.run('DELETE FROM users WHERE username LIKE ?', ['benchmark_user_%']);
  } catch (e) { /* ignore */ }
  const userResult = await db.run(
    `INSERT INTO users (username, password_hash, role, is_active, quota_limit, currency) VALUES (?, ?, ?, true, 1000, 'CNY')`,
    [username, passwordHash, 'user']
  );
  const userId = userResult.lastInsertRowid || userResult.rows?.[0]?.id;
  console.log('[Benchmark] created user:', userId);

  // 生成测试日志
  const logCount = parseInt(process.env.LOG_COUNT, 10) || 50000;
  console.log(`[Benchmark] inserting ${logCount} request_logs...`);
  const batchSize = 500;
  const now = new Date();
  for (let b = 0; b < logCount / batchSize; b++) {
    const rows = [];
    const params = [];
    for (let i = 0; i < batchSize; i++) {
      const idx = b * batchSize + i;
      if (idx >= logCount) break;
      const createdAt = new Date(now.getTime() - Math.random() * 30 * 24 * 60 * 60 * 1000);
      const tokens = Math.floor(Math.random() * 5000) + 1;
      const cost = Math.random() * 0.5;
      rows.push(`(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      params.push(
        userId, null, null, 'gpt-4', 'openai',
        Math.floor(tokens / 2), Math.floor(tokens / 2), tokens, 0,
        0, 0, 200, Math.floor(Math.random() * 500),
        null, cost, 0, null, null,
        createdAt.toISOString()
      );
    }
    if (rows.length === 0) continue;
    const sql = `INSERT INTO request_logs (
      user_id, user_key_id, source_id, model, protocol,
      input_tokens, output_tokens, total_tokens, cached_tokens,
      cache_creation_tokens, uncached_tokens, status_code, latency_ms,
      error_message, cost, has_thinking, instance_id, workspace_id, created_at
    ) VALUES ${rows.join(', ')}`;
    await db.run(sql, params);
  }
  console.log('[Benchmark] insert done');

  // Backfill aggregation table for this user so dashboard reads the pre-aggregated rows.
  console.log('[Benchmark] backfilling user_daily_model_stats...');
  const backfillStart = Date.now();
  await db.run(`
    INSERT INTO user_daily_model_stats (user_id, date, model, requests, tokens, cost)
    SELECT user_id, created_at::date::text as date, COALESCE(model, 'unknown'), COUNT(*) as requests,
           SUM(total_tokens) as tokens, SUM(cost) as cost
    FROM request_logs
    WHERE user_id = ?
    GROUP BY user_id, created_at::date, COALESCE(model, 'unknown')
    ON CONFLICT (user_id, date, model) DO UPDATE SET
      requests = user_daily_model_stats.requests + EXCLUDED.requests,
      tokens = user_daily_model_stats.tokens + EXCLUDED.tokens,
      cost = user_daily_model_stats.cost + EXCLUDED.cost,
      updated_at = CURRENT_TIMESTAMP
  `, [userId]);
  console.log(`[Benchmark] backfill done in ${Date.now() - backfillStart}ms`);

  // 构造 token
  const token = jwt.sign(
    { id: userId, username, role: 'user' },
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: '7d' }
  );

  // 加载应用并压测 /user/stats
  const { createTestApp } = require('../tests/utils');
  const app = createTestApp();

  const iterations = parseInt(process.env.ITERATIONS, 10) || 100;
  console.log(`[Benchmark] warming up /user/stats with ${iterations} requests...`);
  for (let i = 0; i < 3; i++) {
    await request(app).get('/user/stats').set('Authorization', `Bearer ${token}`);
  }

  const start = Date.now();
  for (let i = 0; i < iterations; i++) {
    await request(app).get('/user/stats').set('Authorization', `Bearer ${token}`);
  }
  const elapsed = Date.now() - start;
  console.log(`[Benchmark] ${iterations} requests in ${elapsed}ms, avg ${(elapsed / iterations).toFixed(2)}ms/request`);

  process.exit(0);
}

main().catch(e => {
  console.error('[Benchmark] error:', e);
  process.exit(1);
});
