require('dotenv').config();
const db = require('../src/config/database');

async function main() {
  await db.initDatabase();
  const start = Date.now();
  console.log('[Backfill] Starting...');

  await db.run(`
    INSERT INTO user_daily_model_stats (user_id, date, model, requests, tokens, cost)
    SELECT user_id, created_at::date::text as date, COALESCE(model, 'unknown'), COUNT(*) as requests,
           SUM(total_tokens) as tokens, SUM(cost) as cost
    FROM request_logs
    WHERE user_id IS NOT NULL AND created_at >= (CURRENT_DATE - INTERVAL '30 days')
    GROUP BY user_id, created_at::date, COALESCE(model, 'unknown')
    ON CONFLICT (user_id, date, model) DO UPDATE SET
      requests = user_daily_model_stats.requests + EXCLUDED.requests,
      tokens = user_daily_model_stats.tokens + EXCLUDED.tokens,
      cost = user_daily_model_stats.cost + EXCLUDED.cost,
      updated_at = CURRENT_TIMESTAMP
  `);

  const aggCount = await db.get('SELECT COUNT(*) as count FROM user_daily_model_stats');
  console.log('[Backfill] Done in', Date.now() - start, 'ms, rows:', aggCount.count);
}

main().catch(e => {
  console.error('[Backfill] error:', e);
  process.exit(1);
});
