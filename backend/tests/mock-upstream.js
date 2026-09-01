/**
 * Mock Upstream Server for High-Concurrency SSE Testing
 * Simulates various failure modes that occur under load
 */
const http = require('http');
const { Readable } = require('stream');

const PORT = 9999;
let requestCount = 0;

// UTF-8 test content with multi-byte Chinese characters split across events
const TEST_CONTENT = [
  '{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"你好"},"finish_reason":null}]}',
  '{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":null}]}',
  '{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"，这是一个"},"finish_reason":null}]}',
  '{"id":"chatcmpl-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"测试"},"finish_reason":null}]}',
];

function createSSEResponse(contentArray, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  
  let i = 0;
  const interval = setInterval(() => {
    if (i >= contentArray.length) {
      res.write('data: [DONE]\n\n');
      res.end();
      clearInterval(interval);
      return;
    }
    res.write(`data: ${contentArray[i]}\n\n`);
    i++;
  }, 10); // fast streaming
}

function createUTF8SplitResponse(res) {
  // Simulate UTF-8 multi-byte character split across chunks
  // "测" = 0xE6 0xB5 0x8B, "试" = 0xE8 0xAF 0x95
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  
  // First chunk: partial UTF-8 (first 2 bytes of "测")
  const prefix = 'data: {"id":"1","choices":[{"delta":{"content":"';
  const suffix = '"}}]}\n\n';
  
  // Send "测" split across two writes to test StringDecoder
  const ce = Buffer.from('测'); // e6 b5 8b
  res.write(prefix);
  res.write(Buffer.from([0xe6, 0xb5])); // first 2 bytes
  
  setTimeout(() => {
    res.write(Buffer.from([0x8b])); // last byte
    res.write('试'); // complete character
    res.write(suffix);
    res.write('data: [DONE]\n\n');
    res.end();
  }, 5);
}

const server = http.createServer((req, res) => {
  requestCount++;
  const n = requestCount;
  
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404).end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  
  // Read body to check stream parameter
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    let json;
    try { json = JSON.parse(body); } catch (e) { json = {}; }
    
    // 100% normal SSE for final validation
    console.log(`[Mock] #${n} → Normal SSE`);
    createSSEResponse(TEST_CONTENT, res);
  });
});

server.listen(PORT, () => {
  console.log(`[MockUpstream] Listening on http://localhost:${PORT}/v1/chat/completions`);
  console.log('[MockUpstream] Scenarios: 0=normal, 1=utf8-split, 2=429, 3=500, 4=200+json, 5=200+html, 6=empty, 7=disconnect, 8=malformed, 9=503');
});
