// 示範：兩個平台同時賣最後一件，然後把庫存推到一個會限流、會壞掉的平台。
// 執行：npm run demo
import { openDb } from './db.ts'
import { Inventory } from './inventory.ts'
import { MockPlatform } from './adapters/mock.ts'
import { syncOrders, pushStockLevels } from './sync.ts'

const inv = new Inventory(openDb())
inv.addProduct('HOT-1', '熱門商品（只剩 1 件）', 1)
inv.addProduct('NORMAL-1', '一般商品', 50)

const shopee = new MockPlatform({ name: 'shopee', seed: 1, delayMs: [5, 30] })
const momo = new MockPlatform({ name: 'momo', seed: 2, delayMs: [5, 30] })
shopee.placeOrder('S-1001', 'HOT-1', 1)
momo.placeOrder('M-2001', 'HOT-1', 1)
momo.placeOrder('M-2002', 'NORMAL-1', 5)

console.log('① 兩個平台同時下單搶最後一件')
const reports = await Promise.all([syncOrders(inv, shopee), syncOrders(inv, momo)])
for (const r of reports) for (const x of r.results) console.log(`   ${r.platform} ${x.externalId} ${x.sku} → ${x.result}`)
console.log('   庫存：', inv.list().map((p) => `${p.sku} 實體 ${p.onHand} 預留 ${p.reserved} 可售 ${p.available}`).join('；'))

console.log('\n② 推可售量到一個 40% 限流、20% 壞掉的平台（指數退避重試）')
const flaky = new MockPlatform({ name: 'flaky', seed: 3, rateLimitRate: 0.4, errorRate: 0.2 })
const push = await pushStockLevels(inv, flaky, {
  attempts: 4,
  baseMs: 10,
  onRetry: (n, err) => console.log(`   重試第 ${n} 次：${(err as Error).message}`),
})
console.log('   成功：', push.ok, ' 失敗：', push.failed)
