/**
 * High-Concurrency Stress Test for SSE Streaming
 * Sends concurrent requests to Gateway and validates responses
 */
const http = require('http');

const GATEWAY_URL = 'localhost';
const GATEWAY_PORT = 3000;
const API_KEY = process.env.TEST_API_KEY || 'sk-test-key';
const MODEL = process.env.TEST_MODEL || 'mimo-v2.5-pro';
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 50;
const TOTAL_REQUESTS = parseInt(process.env.TOTAL_REQUESTS) || 200;

const stats = {
  total: 0,
  success: 0,
  httpError: 0,
  decodeError: 0,
  emptyContent: 0,
  networkError: 0,
  timeout: 0,
  otherError: 0,
};

const errors = [];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function makeRequest(id) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const reqBody = JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    
    const req = http.request({
      hostname: GATEWAY_URL,
      port: GATEWAY_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }, (res) => {
      const statusCode = res.statusCode;
      const contentType = res.headers['content-type'] || '';
      
      let rawData = '';
      let sseEvents = [];
      let hasDone = false;
      let hasContent = false;
      
      res.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        rawData += text;
        
        // Parse SSE events
        const lines = text.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') {
              hasDone = true;
            } else {
              try {
                const parsed = JSON.parse(data);
                sseEvents.push(parsed);
                if (parsed.choices?.[0]?.delta?.content) {
                  hasContent = true;
                }
              } catch (e) {
                // Malformed JSON in SSE line
              }
            }
          }
        }
      });
      
      res.on('end', () => {
        const latency = Date.now() - startTime;
        stats.total++;
        
        if (statusCode !== 200) {
          stats.httpError++;
          errors.push({ id, statusCode, contentType, latency, error: `HTTP ${statusCode}`, preview: rawData.slice(0, 200) });
          resolve();
          return;
        }
        
        // Check for non-SSE content type
        if (contentType.includes('application/json') && !contentType.includes('event-stream')) {
          stats.decodeError++;
          errors.push({ id, statusCode, contentType, latency, error: 'Non-SSE Content-Type', preview: rawData.slice(0, 200) });
          resolve();
          return;
        }
        
        // Check for HTML in response
        if (rawData.includes('<!DOCTYPE') || rawData.includes('<html')) {
          stats.decodeError++;
          errors.push({ id, statusCode, contentType, latency, error: 'HTML in SSE stream', preview: rawData.slice(0, 200) });
          resolve();
          return;
        }
        
        // Check for empty content (no valid SSE events with content)
        if (!hasContent && !hasDone) {
          stats.emptyContent++;
          errors.push({ id, statusCode, contentType, latency, error: 'Empty SSE stream', preview: rawData.slice(0, 200) });
          resolve();
          return;
        }
        
        // Check for UTF-8 corruption
        if (rawData.includes('\uFFFD')) {
          stats.decodeError++;
          errors.push({ id, statusCode, contentType, latency, error: 'UTF-8 corruption (�)', preview: rawData.slice(0, 200) });
          resolve();
          return;
        }
        
        stats.success++;
        resolve();
      });
      
      res.on('error', (err) => {
        stats.total++;
        stats.networkError++;
        errors.push({ id, statusCode, error: `Response error: ${err.message}` });
        resolve();
      });
    });
    
    req.on('error', (err) => {
      stats.total++;
      stats.networkError++;
      errors.push({ id, error: `Request error: ${err.message}` });
      resolve();
    });
    
    req.on('timeout', () => {
      req.destroy();
      stats.total++;
      stats.timeout++;
      errors.push({ id, error: 'Timeout' });
      resolve();
    });
    
    req.write(reqBody);
    req.end();
  });
}

async function run() {
  console.log(`\n=== SSE Stress Test ===`);
  console.log(`Gateway: http://${GATEWAY_URL}:${GATEWAY_PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Total Requests: ${TOTAL_REQUESTS}`);
  console.log('');
  
  const start = Date.now();
  let completed = 0;
  
  // Process in batches
  for (let i = 0; i < TOTAL_REQUESTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j < TOTAL_REQUESTS; j++) {
      batch.push(makeRequest(i + j + 1));
    }
    await Promise.all(batch);
    completed += batch.length;
    
    if (completed % 50 === 0 || completed === TOTAL_REQUESTS) {
      process.stdout.write(`\rProgress: ${completed}/${TOTAL_REQUESTS} (${stats.success} OK, ${stats.httpError} HTTP_ERR, ${stats.decodeError} DECODE_ERR, ${stats.emptyContent} EMPTY, ${stats.networkError} NET_ERR, ${stats.timeout} TIMEOUT)`);
    }
  }
  
  const duration = Date.now() - start;
  
  console.log('\n\n=== Results ===');
  console.log(`Duration: ${(duration / 1000).toFixed(1)}s`);
  console.log(`RPS: ${(TOTAL_REQUESTS / (duration / 1000)).toFixed(1)}`);
  console.log(`Success: ${stats.success} (${((stats.success / TOTAL_REQUESTS) * 100).toFixed(1)}%)`);
  console.log(`HTTP Error: ${stats.httpError}`);
  console.log(`Decode Error: ${stats.decodeError}`);
  console.log(`Empty Content: ${stats.emptyContent}`);
  console.log(`Network Error: ${stats.networkError}`);
  console.log(`Timeout: ${stats.timeout}`);
  console.log(`Other: ${stats.otherError}`);
  
  if (errors.length > 0) {
    console.log('\n=== Error Details (first 20) ===');
    errors.slice(0, 20).forEach((e, i) => {
      console.log(`\n[${i + 1}] Request #${e.id}: ${e.error}`);
      if (e.statusCode) console.log(`    HTTP ${e.statusCode}, Content-Type: ${e.contentType}`);
      if (e.preview) console.log(`    Preview: ${e.preview.replace(/\n/g, '\\n').slice(0, 150)}`);
    });
  }
  
  const failRate = (TOTAL_REQUESTS - stats.success) / TOTAL_REQUESTS;
  if (failRate > 0.05) {
    console.log(`\n❌ FAIL: Failure rate ${(failRate * 100).toFixed(1)}% > 5%`);
    process.exit(1);
  } else {
    console.log(`\n✅ PASS: Failure rate ${(failRate * 100).toFixed(1)}% <= 5%`);
    process.exit(0);
  }
}

run().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
