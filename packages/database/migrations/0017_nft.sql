-- NFT collections (catalog managed by admin)
CREATE TABLE IF NOT EXISTS nft_collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(80) UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  /** Startonus collection identifier (from @startonus_bot /createCollection result) */
  startonus_collection_id TEXT,
  /** Mint price in nano TON (1 TON = 1e9 nano) */
  price_nano_ton BIGINT NOT NULL,
  /** Optional max supply limit. NULL = unlimited. */
  max_supply INTEGER,
  minted_count INTEGER DEFAULT 0 NOT NULL,
  status VARCHAR(20) DEFAULT 'draft' NOT NULL, -- draft / active / sold_out / archived
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nft_collections_status ON nft_collections(status);

-- NFT purchases (one row per buy attempt; status tracks mint lifecycle)
CREATE TABLE IF NOT EXISTS nft_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES nft_collections(id) ON DELETE RESTRICT,
  /** Telegram user (FK to tg_users, not users) — TMA is primary surface */
  tg_user_id BIGINT NOT NULL,
  /** Startonus invoice id returned by generate-invoice */
  startonus_invoice_id TEXT,
  /** Recipient TON address (wallet linked through TON Connect) */
  recipient_address TEXT NOT NULL,
  /** Mint price in nano TON (snapshot at purchase time) */
  price_nano_ton BIGINT NOT NULL,
  /** Lifecycle: pending → paid → minted | failed | expired */
  status VARCHAR(20) DEFAULT 'pending' NOT NULL,
  /** TON tx hash after user signs */
  tx_hash TEXT,
  /** NFT contract address after mint */
  nft_address TEXT,
  /** Error string if failed */
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  paid_at TIMESTAMPTZ,
  minted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nft_purchases_user ON nft_purchases(tg_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nft_purchases_status ON nft_purchases(status);
CREATE INDEX IF NOT EXISTS idx_nft_purchases_invoice ON nft_purchases(startonus_invoice_id);
