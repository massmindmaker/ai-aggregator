-- Plan 05: TON Connect wallet linking + top-up
-- TMA-side ton_wallets, balances, topups

CREATE TABLE IF NOT EXISTS ton_wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id BIGINT NOT NULL,
  address TEXT NOT NULL,
  public_key TEXT,
  is_verified BOOLEAN DEFAULT FALSE NOT NULL,
  linked_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  last_seen_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  CONSTRAINT uq_user_address UNIQUE (tg_user_id, address)
);

CREATE INDEX IF NOT EXISTS idx_ton_wallets_user ON ton_wallets(tg_user_id);
CREATE INDEX IF NOT EXISTS idx_ton_wallets_address ON ton_wallets(address);

-- Балансы для TMA-юзеров (₽). Простая модель: один кошелёк = один счёт.
CREATE TABLE IF NOT EXISTS tg_user_balances (
  tg_user_id BIGINT PRIMARY KEY,
  balance_rub NUMERIC(14,4) DEFAULT 0 NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Журнал top-up через TON
CREATE TABLE IF NOT EXISTS tg_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id BIGINT NOT NULL,
  wallet_address TEXT NOT NULL,
  amount_nano_ton BIGINT NOT NULL,
  rate_rub_per_ton NUMERIC(12,4) NOT NULL,
  amount_rub NUMERIC(14,4) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' NOT NULL,
  tx_hash TEXT,
  comment_tag TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tg_topups_user ON tg_topups(tg_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_topups_status ON tg_topups(status);
CREATE INDEX IF NOT EXISTS idx_tg_topups_comment ON tg_topups(comment_tag);
