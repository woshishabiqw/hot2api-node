const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('../src/config/database');

function loadEnv(filePath) {
  const env = {};
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      let key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[key] = value;
    }
  } catch {}
  return env;
}
loadEnv(path.join(__dirname, '..', '.env'));

const BASE_URL = 'http://localhost:3000';
const USERNAME = `uitest_${Date.now()}`;
const PASSWORD = 'UiTest123!';

(async () => {
  const reg = await axios.post(`${BASE_URL}/auth/register`, { username: USERNAME, password: PASSWORD });
  const userId = reg.data.id;
  await db.run('UPDATE users SET role = ? WHERE id = ?', ['admin', userId]);
  const login = await axios.post(`${BASE_URL}/auth/login`, { username: USERNAME, password: PASSWORD });
  const ws = await axios.post(`${BASE_URL}/workspaces`, { name: `UI Test WS ${Date.now()}` }, { headers: { Authorization: `Bearer ${login.data.token}` } });
  console.log(JSON.stringify({ username: USERNAME, password: PASSWORD, token: login.data.token, userId, workspaceId: ws.data.id }));
})().catch(e => { console.error(e.message); process.exit(1); });
