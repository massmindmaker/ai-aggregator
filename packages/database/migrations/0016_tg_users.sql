CREATE TABLE IF NOT EXISTS tg_users (
  telegram_id BIGINT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  username TEXT,
  photo_url TEXT,
  language_code VARCHAR(10),
  auth_date TIMESTAMPTZ NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_users_user_id ON tg_users(user_id);
