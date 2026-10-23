import { DatabaseSync } from 'node:sqlite'

// 開資料庫並建表。預設用記憶體，測試與示範都不會留檔案。
export function openDb(path = ':memory:'): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA foreign_keys = ON;

    -- 商品與庫存。可售量 = on_hand - reserved，不另存，避免兩個欄位對不起來。
    CREATE TABLE IF NOT EXISTS products (
      sku      TEXT PRIMARY KEY,
      name     TEXT NOT NULL,
      on_hand  INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),   -- 實體量
      reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),  -- 已接單、未出貨
      version  INTEGER NOT NULL DEFAULT 0                          -- 樂觀鎖版本號
    );

    -- 平台訂單。主鍵 (platform, external_id) 保證同一張訂單只會被處理一次（冪等）。
    CREATE TABLE IF NOT EXISTS orders (
      platform    TEXT NOT NULL,
      external_id TEXT NOT NULL,
      sku         TEXT NOT NULL REFERENCES products(sku),
      qty         INTEGER NOT NULL CHECK (qty > 0),
      status      TEXT NOT NULL CHECK (status IN ('reserved', 'shipped', 'cancelled', 'rejected')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, external_id)
    );

    -- 庫存帳本：每一次變動留一筆流水，儀表板與對帳都靠它。
    CREATE TABLE IF NOT EXISTS stock_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sku            TEXT NOT NULL REFERENCES products(sku),
      delta_on_hand  INTEGER NOT NULL DEFAULT 0,
      delta_reserved INTEGER NOT NULL DEFAULT 0,
      reason         TEXT NOT NULL,   -- receive | reserve | ship | cancel
      ref            TEXT,            -- 例如 "shopee:ORD-1"
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
  return db
}

// 把一段操作包成交易。BEGIN IMMEDIATE 會先拿寫鎖，多個程序同時寫同一個檔案時不會互相踩到。
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
