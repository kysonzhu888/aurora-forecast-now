CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  page_key TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'visible',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_comments_page_created
ON comments (page_key, created_at DESC);

-- Storm alert email waitlist（2026-07-03）：只收集意向，不发邮件；
-- email+city 唯一约束配合 INSERT OR IGNORE 做幂等去重
CREATE TABLE IF NOT EXISTS alert_signups (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  city_slug TEXT NOT NULL DEFAULT '',
  source_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (email, city_slug)
);

CREATE INDEX IF NOT EXISTS idx_alert_signups_created
ON alert_signups (created_at DESC);

-- Aurora Pro 只记录匿名每日聚合漏斗，不存城市、邮箱、license key 或 IP。
CREATE TABLE IF NOT EXISTS pro_funnel_daily (
  event_date TEXT NOT NULL,
  event_name TEXT NOT NULL,
  page_type TEXT NOT NULL,
  location_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_date, event_name, page_type, location_count)
);

CREATE INDEX IF NOT EXISTS idx_pro_funnel_daily_event_date
ON pro_funnel_daily (event_name, event_date DESC);

-- Lemon Squeezy 只保存不可逆事件摘要，用于抵御 webhook 重试重复计数；不存订单号或客户 PII。
CREATE TABLE IF NOT EXISTS pro_webhook_receipts (
  event_hash TEXT PRIMARY KEY,
  source_event_name TEXT NOT NULL,
  test_mode INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pro_webhook_receipts_received
ON pro_webhook_receipts (source_event_name, received_at DESC);
