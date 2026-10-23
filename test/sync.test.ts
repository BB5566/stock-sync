import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { Inventory } from '../src/inventory.ts'
import { MockPlatform } from '../src/adapters/mock.ts'
import { RateLimited } from '../src/adapters/types.ts'
import { syncOrders, pushStockLevels } from '../src/sync.ts'
import { withRetry } from '../src/retry.ts'

test('兩個平台同時賣最後一件：只有一張成立，另一張被拒', async () => {
  const inv = new Inventory(openDb())
  inv.addProduct('SKU-1', '最後一件', 1)

  const shopee = new MockPlatform({ name: 'shopee', seed: 1, delayMs: [1, 5] })
  const momo = new MockPlatform({ name: 'momo', seed: 2, delayMs: [1, 5] })
  shopee.placeOrder('S-1', 'SKU-1', 1)
  momo.placeOrder('M-1', 'SKU-1', 1)

  const [a, b] = await Promise.all([syncOrders(inv, shopee), syncOrders(inv, momo)])
  const results = [...a.results, ...b.results].map((r) => r.result).sort()

  assert.deepEqual(results, ['out_of_stock', 'reserved'])
  assert.equal(inv.get('SKU-1')!.available, 0)
  const acks = [...shopee.acks, ...momo.acks].map((x) => x.result).sort()
  assert.deepEqual(acks, ['accepted', 'rejected'])
})

test('同一批訂單再同步一次不會重複扣（冪等）', async () => {
  const inv = new Inventory(openDb())
  inv.addProduct('SKU-1', '商品', 10)
  const shopee = new MockPlatform({ name: 'shopee' })
  shopee.placeOrder('S-1', 'SKU-1', 3)

  await syncOrders(inv, shopee)
  shopee.placeOrder('S-1', 'SKU-1', 3) // 平台因為沒收到 ack 又送了一次同一張
  const second = await syncOrders(inv, shopee)

  assert.equal(second.results[0]!.result, 'duplicate')
  assert.equal(inv.get('SKU-1')!.reserved, 3)
})

test('平台限流與 500 會指數退避重試，最後成功', async () => {
  let calls = 0
  const retries: number[] = []
  const value = await withRetry(
    async () => {
      calls++
      if (calls < 3) throw new RateLimited(1)
      return 'ok'
    },
    { attempts: 5, baseMs: 1, onRetry: (n) => retries.push(n) },
  )
  assert.equal(value, 'ok')
  assert.deepEqual(retries, [1, 2])
})

test('重試用完就放棄，不會無限等', async () => {
  await assert.rejects(
    withRetry(async () => { throw new RateLimited(1) }, { attempts: 3, baseMs: 1 }),
    RateLimited,
  )
})

test('推庫存到會壞的平台：單一商品失敗不影響其他商品，失敗有留清單', async () => {
  const inv = new Inventory(openDb())
  for (let i = 1; i <= 20; i++) inv.addProduct(`SKU-${i}`, `商品 ${i}`, i)
  const flaky = new MockPlatform({ name: 'flaky', seed: 7, rateLimitRate: 0.3, errorRate: 0.3 })

  const report = await pushStockLevels(inv, flaky, { attempts: 3, baseMs: 1 })

  assert.equal(report.ok.length + report.failed.length, 20)
  assert.ok(report.ok.length > 0, '有些會成功')
  assert.ok(report.failed.length > 0, '有些會用完重試而失敗（故意的，給儀表板重推）')
  for (const sku of report.ok) assert.equal(flaky.pushed.get(sku), inv.get(sku)!.available)
  assert.ok(flaky.calls.pushStock > 20, '有重試過')
})
