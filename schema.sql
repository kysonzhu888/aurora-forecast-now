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
