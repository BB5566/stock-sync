import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './db.ts'

export type Product = {
  sku: string
  name: string
  onHand: number
  reserved: number
  available: number
  version: number
}

export type ReserveRequest = {
  platform: string
  externalId: string
  sku: string
  qty: number
}

export type ReserveResult = 'reserved' | 'duplicate' | 'out_of_stock' | 'unknown_sku'

type Options = {
  // 測試用鉤子：在「讀完版本」與「條件更新」之間被呼叫，用來模擬另一個程序搶先改了庫存。
  beforeWrite?: () => void
}

const MAX_LOCK_RETRY = 5

// 庫存服務。規則只有一條：可售量 = 實體量 - 預留量，任何扣減都要先過這條。
export class Inventory {
  db: DatabaseSync
  beforeWrite: () => void

  constructor(db: DatabaseSync, options: Options = {}) {
    this.db = db
    this.beforeWrite = options.beforeWrite ?? (() => {})
  }

  addProduct(sku: string, name: string, onHand = 0): void {
    this.db.prepare('INSERT INTO products (sku, name, on_hand) VALUES (?, ?, ?)').run(sku, name, onHand)
    if (onHand > 0) this.log(sku, onHand, 0, 'receive', null)
  }

  get(sku: string): Product | undefined {
    const row = this.db
      .prepare('SELECT sku, name, on_hand, reserved, version FROM products WHERE sku = ?')
      .get(sku) as { sku: string; name: string; on_hand: number; reserved: number; version: number } | undefined
    if (!row) return undefined
    return {
      sku: row.sku,
      name: row.name,
      onHand: row.on_hand,
      reserved: row.reserved,
      available: row.on_hand - row.reserved,
      version: row.version,
    }
  }

  list(): Product[] {
    const rows = this.db.prepare('SELECT sku FROM products ORDER BY sku').all() as { sku: string }[]
    return rows.map((r) => this.get(r.sku)!)
  }

  // 進貨
  receive(sku: string, qty: number): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE products SET on_hand = on_hand + ?, version = version + 1 WHERE sku = ?').run(qty, sku)
      this.log(sku, qty, 0, 'receive', null)
    })
  }

  // 接單預留。這是整個系統最關鍵的一步：
  //  1. 同一張平台訂單第二次進來 → 直接回 duplicate，什麼都不做（冪等）。
  //  2. 讀目前版本號與可售量。
  //  3. 條件更新：只有版本沒變、而且還夠賣，才會真的寫入。
  //  4. 寫入失敗就重讀：版本變了代表有人搶先，重試；真的不夠就回 out_of_stock。
  reserve(req: ReserveRequest): ReserveResult {
    for (let attempt = 0; attempt < MAX_LOCK_RETRY; attempt++) {
      const result = transaction(this.db, (): ReserveResult | 'retry' => {
        if (this.orderExists(req)) return 'duplicate'

        const product = this.get(req.sku)
        if (!product) return 'unknown_sku'
        if (product.available < req.qty) return this.reject(req)

        this.beforeWrite()

        const changed = this.db
          .prepare(
            `UPDATE products
               SET reserved = reserved + ?, version = version + 1
             WHERE sku = ? AND version = ? AND on_hand - reserved >= ?`,
          )
          .run(req.qty, req.sku, product.version, req.qty).changes

        if (changed === 0) return 'retry' // 版本被別人改掉了，整筆交易放棄、下一圈重來

        this.insertOrder(req, 'reserved')
        this.log(req.sku, 0, req.qty, 'reserve', `${req.platform}:${req.externalId}`)
        return 'reserved'
      })
      if (result !== 'retry') return result
    }
    throw new Error(`reserve ${req.sku}: 連續 ${MAX_LOCK_RETRY} 次撞到版本衝突`)
  }

  // 出貨：預留量轉成真正扣掉實體量。
  ship(platform: string, externalId: string): void {
    this.closeOrder(platform, externalId, 'shipped')
  }

  // 取消：把預留量放回去。
  cancel(platform: string, externalId: string): void {
    this.closeOrder(platform, externalId, 'cancelled')
  }

  private closeOrder(platform: string, externalId: string, next: 'shipped' | 'cancelled'): void {
    transaction(this.db, () => {
      const order = this.db
        .prepare('SELECT sku, qty, status FROM orders WHERE platform = ? AND external_id = ?')
        .get(platform, externalId) as { sku: string; qty: number; status: string } | undefined
      if (!order) throw new Error(`找不到訂單 ${platform}:${externalId}`)
      if (order.status !== 'reserved') return // 已處理過，再呼叫一次不會重複扣（冪等）

      const deltaOnHand = next === 'shipped' ? -order.qty : 0
      this.db
        .prepare('UPDATE products SET on_hand = on_hand + ?, reserved = reserved - ?, version = version + 1 WHERE sku = ?')
        .run(deltaOnHand, order.qty, order.sku)
      this.db.prepare('UPDATE orders SET status = ? WHERE platform = ? AND external_id = ?').run(next, platform, externalId)
      this.log(order.sku, deltaOnHand, -order.qty, next === 'shipped' ? 'ship' : 'cancel', `${platform}:${externalId}`)
    })
  }

  private orderExists(req: ReserveRequest): boolean {
    return (
      this.db.prepare('SELECT 1 FROM orders WHERE platform = ? AND external_id = ?').get(req.platform, req.externalId) !==
      undefined
    )
  }

  private reject(req: ReserveRequest): ReserveResult {
    this.insertOrder(req, 'rejected')
    return 'out_of_stock'
  }

  private insertOrder(req: ReserveRequest, status: 'reserved' | 'rejected'): void {
    this.db
      .prepare('INSERT INTO orders (platform, external_id, sku, qty, status) VALUES (?, ?, ?, ?, ?)')
      .run(req.platform, req.externalId, req.sku, req.qty, status)
  }

  private log(sku: string, deltaOnHand: number, deltaReserved: number, reason: string, ref: string | null): void {
    this.db
      .prepare('INSERT INTO stock_events (sku, delta_on_hand, delta_reserved, reason, ref) VALUES (?, ?, ?, ?, ?)')
      .run(sku, deltaOnHand, deltaReserved, reason, ref)
  }
}
