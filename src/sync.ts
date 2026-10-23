import type { Inventory, ReserveResult } from './inventory.ts'
import type { PlatformAdapter } from './adapters/types.ts'
import { withRetry, type RetryOptions } from './retry.ts'

export type OrderSyncReport = {
  platform: string
  results: { externalId: string; sku: string; result: ReserveResult }[]
}

// 把平台的新訂單拉回來預留庫存，然後回覆平台收或拒。
// 重跑幾次都安全：已處理過的訂單 reserve() 會回 duplicate，不會重複扣。
export async function syncOrders(
  inventory: Inventory,
  platform: PlatformAdapter,
  retry: RetryOptions = {},
): Promise<OrderSyncReport> {
  const orders = await withRetry(() => platform.pullOrders(), retry)
  const report: OrderSyncReport = { platform: platform.name, results: [] }

  for (const order of orders) {
    const result = inventory.reserve({ platform: platform.name, ...order })
    report.results.push({ externalId: order.externalId, sku: order.sku, result })

    const ack = result === 'reserved' || result === 'duplicate' ? 'accepted' : 'rejected'
    await withRetry(() => platform.ackOrder(order.externalId, ack), retry)
  }
  return report
}

export type StockPushReport = {
  platform: string
  ok: string[]
  failed: { sku: string; error: string }[]
}

// 把每個商品的可售量推到平台。單一商品失敗不影響其他商品，失敗清單留給儀表板與重推。
export async function pushStockLevels(
  inventory: Inventory,
  platform: PlatformAdapter,
  retry: RetryOptions = {},
): Promise<StockPushReport> {
  const report: StockPushReport = { platform: platform.name, ok: [], failed: [] }
  for (const product of inventory.list()) {
    try {
      await withRetry(() => platform.pushStock(product.sku, product.available), retry)
      report.ok.push(product.sku)
    } catch (err) {
      report.failed.push({ sku: product.sku, error: String(err) })
    }
  }
  return report
}
