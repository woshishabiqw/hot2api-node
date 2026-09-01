const http = require('http');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_PATH = process.env.API_PATH || '/v1/chat/completions';
const TOKEN = process.env.TOKEN || 'sk-loadtest-rwn15490jy';
const MODEL = process.env.MODEL || 'mimo-v2.5-pro-均衡模式';
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 10;
const TOTAL = parseInt(process.env.TOTAL, 10) || 100;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS, 10) || 10;
const STREAM = process.env.STREAM === '1';

let completed = 0;
let succeeded = 0;
let failed = 0;
let latencies = [];

function makeRequest(id) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: `hello ${id}` }],
      max_tokens: MAX_TOKENS,
      stream: STREAM
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
        else failed++;
        completed++;
        if (completed % 10 === 0 || completed === TOTAL) {
          process.stdout.write(`\rprogress ${completed}/${TOTAL} success=${succeeded} fail=${failed}`);
        }
        resolve({ id, status: res.statusCode, latency, body: data.length > 200 ? data.slice(0, 200) + '...' : data });
      });
    });
    req.on('error', (err) => {
      failed++;
      completed++;
      resolve({ id, status: 0, latency: Date.now() - start, body: err.message });
    });
    req.on('timeout', () => {
      req.destroy();
      failed++;
      completed++;
      resolve({ id, status: 0, latency: Date.now() - start, body: 'timeout' });
    });
    req.write(body, 'utf8');
    req.end();
  });
}

async function run() {
  console.log(`Load test started: concurrency=${CONCURRENCY} total=${TOTAL} model=${MODEL} stream=${STREAM}`);
  const start = Date.now();
  let running = 0;
  let index = 0;
  const results = [];

  function launchNext() {
    if (index >= TOTAL) return;
    const id = index++;
    running++;
    makeRequest(id).then((r) => {
      results.push(r);
      running--;
      launchNext();
    });
  }

  for (let i = 0; i < CONCURRENCY; i++) launchNext();

  while (completed < TOTAL) {
    await new Promise(r => setTimeout(r, 100));
  }

  const totalTime = Date.now() - start;
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  console.log('\n--- summary ---');
  console.log(`total time: ${totalTime}ms`);
  console.log(`success: ${succeeded}  fail: ${failed}`);
  console.log(`rps: ${(TOTAL / (totalTime / 1000)).toFixed(2)}`);
  console.log(`latency p50=${p50}ms p95=${p95}ms p99=${p99}ms`);
  const fails = results.filter(r => r.status !== 200).slice(0, 5);
  if (fails.length) {
    console.log('sample failures:');
    fails.forEach(f => console.log(`  [${f.status}] ${f.body}`));
  }
}

run().catch(e => { console.error(e); process.exit(1); });
