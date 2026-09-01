const http = require('http');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_PATH = process.env.API_PATH || '/v1/chat/completions';
const TOKEN = process.env.TOKEN || 'sk-loadtest-rwn15490jy';
const MODEL = process.env.MODEL || 'mimo-v2.5-pro-均衡模式';
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const DURATION_SECONDS = parseInt(process.env.DURATION_SECONDS, 10) || 30;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 10;

let completed = 0;
let succeeded = 0;
let failed = 0;
let latencies = [];
let errors = {};
let shouldStop = false;

function makeRequest(id) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: `hello ${id}` }],
      max_tokens: MAX_TOKENS,
      stream: false
    });
    const start = Date.now();
    const req = http.request({
      hostname: HOST,
      port: PORT,
      path: API_PATH,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        const latency = Date.now() - start;
        latencies.push(latency);
        if (res.statusCode >= 200 && res.statusCode < 300) succeeded++;
        else {
          failed++;
          const key = `[${res.statusCode}]`;
          errors[key] = (errors[key] || 0) + 1;
        }
        completed++;
        resolve();
      });
    });
    req.on('error', (err) => {
      failed++;
      const key = `[NET:${err.code || err.message.slice(0,30)}]`;
      errors[key] = (errors[key] || 0) + 1;
      completed++;
      resolve();
    });
    req.on('timeout', () => {
      req.destroy();
      failed++;
      errors['[NET:timeout]'] = (errors['[NET:timeout]'] || 0) + 1;
      completed++;
      resolve();
    });
    req.write(body, 'utf8');
    req.end();
  });
}

async function worker() {
  let id = 0;
  while (!shouldStop) {
    await makeRequest(id++);
  }
}

async function run() {
  console.log(`Sustained load test: concurrency=${CONCURRENCY} duration=${DURATION_SECONDS}s model=${MODEL}`);
  const start = Date.now();
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());

  const reporter = setInterval(() => {
    const elapsed = (Date.now() - start) / 1000;
    process.stdout.write(`\relapsed=${elapsed.toFixed(1)}s completed=${completed} success=${succeeded} fail=${failed}`);
  }, 1000);

  setTimeout(() => {
    shouldStop = true;
  }, DURATION_SECONDS * 1000);

  await Promise.all(workers);
  clearInterval(reporter);

  const totalTime = Date.now() - start;
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
  console.log('\n--- summary ---');
  console.log(`total time: ${totalTime}ms`);
  console.log(`success: ${succeeded}  fail: ${failed}`);
  console.log(`rps: ${(completed / (totalTime / 1000)).toFixed(2)}`);
  console.log(`latency p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  console.log('error distribution:', errors);
}

run().catch(e => { console.error(e); process.exit(1); });
