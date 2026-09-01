const path = require('path');

// Load test environment before any database connection is established.
// This prevents tests from touching the production database.
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true });

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  throw new Error('DATABASE_URL is not set. Tests require .env.test with a dedicated test database.');
}

let dbName;
try {
  dbName = new URL(dbUrl).pathname.replace(/^\//, '');
} catch {
  throw new Error(`DATABASE_URL is invalid: ${dbUrl}`);
}

if (!dbName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against non-test database "${dbName}". ` +
    `The test database name must end with "_test" (e.g. api_key_test).`
  );
}
