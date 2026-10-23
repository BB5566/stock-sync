import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.ts'
import { Inventory } from '../src/inventory.ts'

function setup(onHand = 1) {
  const db = openDb()
  const inv = new Inventory(db)
  inv.addProduct('SKU-1', '熱門商品', onHand)
  return { db, inv }
}

test('可售量 = 實體量 - 預留量', () => {
  const { inv } = setup(10)
  inv.reserve({ platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 3 })
  assert.deepEqual(pick(inv.get('SKU-1')!), { onHand: 10, reserved: 3, available: 7 })
})

test('不夠賣就拒單，庫存不動', () => {
  const { inv } = setup(1)
  assert.equal(inv.reserve({ platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 2 }), 'out_of_stock')
  assert.deepEqual(pick(inv.get('SKU-1')!), { onHand: 1, reserved: 0, available: 1 })
})

test('同一張訂單重送只扣一次（冪等）', () => {
  const { inv } = setup(5)
  const order = { platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 2 }
  assert.equal(inv.reserve(order), 'reserved')
  assert.equal(inv.reserve(order), 'duplicate')
  assert.equal(inv.reserve(order), 'duplicate')
  assert.equal(inv.get('SKU-1')!.reserved, 2)
})

test('出貨扣實體量、取消放回預留量，重複呼叫不會重扣', () => {
  const { inv } = setup(5)
  inv.reserve({ platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 2 })
  inv.reserve({ platform: 'momo', externalId: 'B', sku: 'SKU-1', qty: 1 })

  inv.ship('shopee', 'A')
  inv.ship('shopee', 'A') // 第二次是 no-op
  assert.deepEqual(pick(inv.get('SKU-1')!), { onHand: 3, reserved: 1, available: 2 })

  inv.cancel('momo', 'B')
  assert.deepEqual(pick(inv.get('SKU-1')!), { onHand: 3, reserved: 0, available: 3 })
})

test('樂觀鎖：寫入前被別人搶先改了，會重讀再決定', () => {
  const { db } = setup(1)
  let intruded = false
  const inv = new Inventory(db, {
    beforeWrite() {
      // 模擬另一個程序在我們「讀完」到「寫入」之間把最後一件賣掉（直接改資料列）
      if (intruded) return
      intruded = true
      db.prepare('UPDATE products SET reserved = reserved + 1, version = version + 1 WHERE sku = ?').run('SKU-1')
    },
  })

  const result = inv.reserve({ platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 1 })
  assert.equal(result, 'out_of_stock') // 條件更新 0 筆 → 重試 → 重讀發現沒貨了
  assert.equal(intruded, true)
  assert.deepEqual(pick(inv.get('SKU-1')!), { onHand: 1, reserved: 1, available: 0 })
})

test('每一筆變動都留在帳本', () => {
  const { db, inv } = setup(2)
  inv.reserve({ platform: 'shopee', externalId: 'A', sku: 'SKU-1', qty: 1 })
  inv.ship('shopee', 'A')
  const reasons = (db.prepare('SELECT reason FROM stock_events ORDER BY id').all() as { reason: string }[]).map(
    (r) => r.reason,
  )
  assert.deepEqual(reasons, ['receive', 'reserve', 'ship'])
})

function pick(p: { onHand: number; reserved: number; available: number }) {
  return { onHand: p.onHand, reserved: p.reserved, available: p.available }
}
