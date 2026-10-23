import { type PlatformAdapter, type PlatformOrder, RateLimited, PlatformDown } from './types.ts'

export type MockOptions = {
  name: string
  seed?: number // 固定種子 → 每次跑出來的「隨機」都一樣，測試才可重現
  delayMs?: [number, number] // 每次呼叫的延遲範圍，模擬網路
  rateLimitRate?: number // 0～1，多常回 429
  errorRate?: number // 0～1，多常回 500
}

// 模擬平台：會延遲、會限流、會壞掉。所有「隨機」都來自固定種子。
export class MockPlatform implements PlatformAdapter {
  readonly name: string
  pushed = new Map<string, number>() // 平台上目前看到的可售量
  acks: { externalId: string; result: 'accepted' | 'rejected' }[] = []
  calls = { pullOrders: 0, ackOrder: 0, pushStock: 0 }

  private queue: PlatformOrder[] = []
  private rand: () => number
  private delayMs: [number, number]
  private rateLimitRate: number
  private errorRate: number

  constructor(options: MockOptions) {
    this.name = options.name
    this.rand = seededRandom(options.seed ?? 1)
    this.delayMs = options.delayMs ?? [0, 0]
    this.rateLimitRate = options.rateLimitRate ?? 0
    this.errorRate = options.errorRate ?? 0
  }

  // 測試或示範用：在平台上「有人下單」
  placeOrder(externalId: string, sku: string, qty: number): void {
    this.queue.push({ externalId, sku, qty })
  }

  async pullOrders(): Promise<PlatformOrder[]> {
    this.calls.pullOrders++
    await this.chaos()
    return [...this.queue] // 不清空：平台的「未處理訂單」要等我們 ack 才會消失
  }

  async ackOrder(externalId: string, result: 'accepted' | 'rejected'): Promise<void> {
    this.calls.ackOrder++
    await this.chaos()
    this.queue = this.queue.filter((o) => o.externalId !== externalId)
    this.acks.push({ externalId, result })
  }

  async pushStock(sku: string, available: number): Promise<void> {
    this.calls.pushStock++
    await this.chaos()
    this.pushed.set(sku, available)
  }

  // 每次呼叫都先擲骰子：延遲、限流、壞掉
  private async chaos(): Promise<void> {
    const [min, max] = this.delayMs
    if (max > 0) await sleep(min + this.rand() * (max - min))
    const roll = this.rand()
    if (roll < this.rateLimitRate) throw new RateLimited(20)
    if (roll < this.rateLimitRate + this.errorRate) throw new PlatformDown(`${this.name} 500`)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// mulberry32：短小、夠用的可重現亂數
function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
