-- Add coupon support

CREATE TABLE IF NOT EXISTS coupons (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  type TEXT DEFAULT 'threshold_fixed',
  threshold REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  discount_rate REAL DEFAULT 0,
  max_uses INTEGER DEFAULT 0,
  used_count INTEGER DEFAULT 0,
  valid_start TIMESTAMP,
  valid_end TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_coupons (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  coupon_id INTEGER NOT NULL,
  status TEXT DEFAULT 'unused',
  order_id INTEGER,
  issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  used_at TIMESTAMP,
  expires_at TIMESTAMP
);

ALTER TABLE payment_orders
  ADD COLUMN IF NOT EXISTS coupon_id INTEGER,
  ADD COLUMN IF NOT EXISTS original_amount REAL,
  ADD COLUMN IF NOT EXISTS discount_amount REAL;
