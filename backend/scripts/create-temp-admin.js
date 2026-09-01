const db = require('../src/config/database');
const bcrypt = require('bcryptjs');

async function main() {
  const passwordHash = bcrypt.hashSync('Test1234!', 10);
  const existing = await db.get("SELECT id FROM users WHERE username = 'uitestadmin'");
  if (!existing) {
    await db.run(
      "INSERT INTO users (username, password_hash, second_password_hash, role, quota_limit) VALUES (?, ?, ?, 'admin', 0)",
      ['uitestadmin', passwordHash, bcrypt.hashSync('123456', 10)]
    );
    console.log('Created uitestadmin');
  } else {
    await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, existing.id]);
    console.log('Updated uitestadmin password');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
