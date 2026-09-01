require('dotenv').config();

// Project now uses PostgreSQL exclusively.
module.exports = require('./db/postgres');
