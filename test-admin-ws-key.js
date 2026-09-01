const http = require('http');

const API = 'localhost';
const PORT = 3000;

function request(method, path, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API,
      port: PORT,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, body });
        }
      });
    });

    req.on('error', reject);
    if (data) req.write(JSON.stringify(data));
    req.end();
  });
}

async function run() {
  console.log('1. Admin login');
  const adminLogin = await request('POST', '/user/login', { username: 'testadmin_ui', password: 'testadmin123' });
  console.log('   Status:', adminLogin.status);
  if (!adminLogin.body.token) {
    console.log('   Admin login failed:', adminLogin.body);
    return;
  }
  const adminToken = adminLogin.body.token;
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  const timestamp = Date.now();
  console.log('2. Create test user');
  const userRes = await request('POST', '/user/register', { username: `testuser_${timestamp}`, password: 'testpass123' });
  console.log('   Status:', userRes.status);

  const userLogin = await request('POST', '/user/login', { username: `testuser_${timestamp}`, password: 'testpass123' });
  const userToken = userLogin.body.token;
  const userHeaders = { Authorization: `Bearer ${userToken}` };

  console.log('3. Create workspace as test user');
  const wsRes = await request('POST', '/workspaces', { name: `Admin Test WS ${timestamp}` }, userHeaders);
  console.log('   Status:', wsRes.status);
  const wsId = wsRes.body.id;

  console.log('4. Admin creates workspace key via admin endpoint');
  const keyRes = await request('POST', `/admin/workspaces/${wsId}/keys`, { name: 'Admin Created Key' }, adminHeaders);
  console.log('   Status:', keyRes.status, 'Body:', JSON.stringify(keyRes.body));

  if (keyRes.status !== 201) {
    console.log('   FAILED');
    return;
  }

  console.log('5. Admin lists workspace keys');
  const listRes = await request('GET', `/admin/workspaces/${wsId}/keys`, null, adminHeaders);
  console.log('   Status:', listRes.status, 'Count:', listRes.body?.length || 0);

  const keyId = keyRes.body.id;
  console.log('6. Admin deletes workspace key');
  const deleteRes = await request('DELETE', `/admin/workspaces/${wsId}/keys/${keyId}`, null, adminHeaders);
  console.log('   Status:', deleteRes.status);

  console.log('7. Cleanup: delete workspace');
  await request('DELETE', `/workspaces/${wsId}`, null, userHeaders);

  console.log('\n✅ Admin workspace key management test completed successfully');
}

run().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
