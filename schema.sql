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
