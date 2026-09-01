const { execSync } = require('child_process');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true });

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Please configure .env.test with a test database URL.');
  process.exit(1);
}

console.log('Initializing test database schema:', new URL(process.env.DATABASE_URL).pathname.replace(/^\//, ''));

try {
  execSync('npx prisma db push --accept-data-loss', {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL }
  });
} catch (err) {
  console.error('Failed to initialize test database:', err.message);
  process.exit(1);
}
