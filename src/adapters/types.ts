// 平台轉接器介面。每個平台（蝦皮、Momo、mock）都只要實作這三件事，
// 核心庫存邏輯完全不用知道對方是誰。
export type PlatformOrder = {
  externalId: string // 平台那邊的訂單編號
  sku: string
  qty: number
}

export interface PlatformAdapter {
  readonly name: string
  // 拉還沒處理的新訂單
  pullOrders(): Promise<PlatformOrder[]>
  // 告訴平台這張訂單我們收了還是拒了（庫存不夠）
  ackOrder(externalId: string, result: 'accepted' | 'rejected'): Promise<void>
  // 把可售量推到平台
  pushStock(sku: string, available: number): Promise<void>
}

// 平台限流（HTTP 429）。retryAfterMs 是平台要我們等多久。
export class RateLimited extends Error {
  retryAfterMs: number
  constructor(retryAfterMs: number) {
    super(`rate limited, retry after ${retryAfterMs}ms`)
    this.name = 'RateLimited'
    this.retryAfterMs = retryAfterMs
  }
}

// 平台掛了（HTTP 5xx），可以重試。
export class PlatformDown extends Error {
  constructor(message = 'platform returned 5xx') {
    super(message)
    this.name = 'PlatformDown'
  }
}
