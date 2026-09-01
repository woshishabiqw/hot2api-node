-- Add user default configuration table

CREATE TABLE IF NOT EXISTS user_defaults (
  id SERIAL PRIMARY KEY,
  tpm INTEGER DEFAULT 10000000,
  rpm INTEGER DEFAULT 100,
  tpd INTEGER DEFAULT 10000000,
  max_concurrent INTEGER DEFAULT 100,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed a single global defaults row if none exists
INSERT INTO user_defaults (id, tpm, rpm, tpd, max_concurrent)
VALUES (1, 10000000, 100, 10000000, 100)
ON CONFLICT (id) DO NOTHING;
