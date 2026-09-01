/**
 * 一次性回填脚本：为所有用户从 request_logs 计算并写入累计字段
 * 用法：
 *   cd backend
 *   node scripts/backfill-user-cumulative.js
 */

require('dotenv').config();

async function main() {
  const db = require('../src/config/database');
  await db.initDatabase();

  const users = await db.all('SELECT id, username FROM users ORDER BY id');
  console.log(`[Backfill] ${users.length} users to process`);

  for (const user of users) {
    const computed = await db.get(`
      SELECT SUM(total_tokens) as total_tokens, COUNT(*) as total_requests, SUM(cost) as total_cost
      FROM request_logs
      WHERE user_id = ?
    `, [user.id]);

    const totalTokens = Number(computed?.total_tokens) || 0;
    const totalRequests = Number(computed?.total_requests) || 0;
    const totalCost = Number(computed?.total_cost) || 0;

    await db.run(
      'UPDATE users SET total_tokens = ?, total_requests = ?, total_cost = ? WHERE id = ?',
      [totalTokens, totalRequests, totalCost, user.id]
    );
    console.log(`[Backfill] user=${user.id} requests=${totalRequests} tokens=${totalTokens} cost=${totalCost.toFixed(4)}`);
  }

  console.log('[Backfill] done');
  process.exit(0);
}

main().catch((e) => {
  console.error('[Backfill] error:', e);
  process.exit(1);
});
