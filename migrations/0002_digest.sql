-- 0002: 日次ダイジェスト用の記事メタ保存 + グローバル状態テーブル
-- page_state に「ダイジェスト表示に必要な記事メタ」を追加する。
-- last_summary は既存カラムを流用。既存行の新カラムは NULL。
ALTER TABLE page_state ADD COLUMN last_title TEXT;
ALTER TABLE page_state ADD COLUMN last_url TEXT;
ALTER TABLE page_state ADD COLUMN last_category TEXT;
ALTER TABLE page_state ADD COLUMN last_author TEXT;

-- app_state: グローバルな Key/Value 状態 (last_digest_time など)。
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
