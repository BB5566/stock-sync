# stock-sync：多平台庫存同步

> 電商賣家在蝦皮、Momo 等多個平台共用同一份庫存時，熱門商品來不及同步就會超賣、被平台罰款。
> 這個專案做「庫存帳本＋平台轉接器」，**沒有任何平台 API 也能完整驗證**併發扣減、限流重試、冪等。

狀態：M1 完成（庫存服務、mock 平台、11 個測試）。M2 做佇列、死信、儀表板。

## 為什麼做這個

我做電商行銷時被這個問題卡住過：平台方說「用 API 同步」，當時連 API 是什麼都不懂，只能用 Excel 擋。
現在用程式把它解掉，並把每個設計決定寫成測試。

## 快速開始

需要 Node 24 以上（用內建 `node:sqlite` 與 TypeScript 型別剝除，零執行期依賴）。

```bash
npm install        # 只裝 typescript 與型別，跑測試其實不需要
npm test           # 11 個測試：併發搶最後一件、冪等、樂觀鎖、限流重試
npm run demo       # 看兩個平台搶最後一件 + 推庫存到會壞的平台
npm run typecheck
```

## 設計

```
平台（蝦皮 / Momo / mock）
        │  PlatformAdapter：pullOrders / ackOrder / pushStock
        ▼
   sync.ts ── syncOrders：拉訂單 → 預留庫存 → 回覆平台
           ── pushStockLevels：把可售量推到各平台（單一商品失敗不拖累其他）
        │  withRetry：限流 (429) 照平台要求等、5xx 指數退避；其他錯誤不重試
        ▼
 inventory.ts ── 可售量 = 實體量 − 預留量
              ── reserve：冪等（同一張平台訂單只處理一次）＋ 樂觀鎖（版本號條件更新）
              ── ship / cancel：預留轉出貨或放回
        ▼
     db.ts ── SQLite：products / orders / stock_events（帳本流水）
```

### 幾個關鍵決定

| 問題 | 做法 | 測試 |
|---|---|---|
| 兩個平台同時賣最後一件 | 預留走交易＋條件更新 `WHERE version = ? AND on_hand - reserved >= ?`，寫不進去就重讀再決定 | `sync.test.ts` 第 1 個、`inventory.test.ts` 樂觀鎖 |
| 平台重送同一張訂單 | `(platform, external_id)` 是主鍵，第二次直接回 `duplicate` | 冪等測試 ×2 |
| 平台限流／壞掉 | `withRetry`：429 依 `retryAfterMs` 等、5xx 指數退避、用完就放棄並留失敗清單 | 重試測試 ×3 |
| 事後對帳 | 每次變動寫一筆 `stock_events`，可售量不另存、永遠從帳算 | 帳本測試 |

### 模擬平台

`MockPlatform` 用固定種子的亂數決定延遲、限流、故障，所以測試可重現、失敗可重播。

## 里程碑

- [x] M1：庫存服務＋mock 平台＋併發／冪等／重試測試
- [ ] M2：同步佇列（限流、退避、死信）、失敗告警（Telegram）、儀表板（Vue 3）與一鍵重推
- [ ] M3：README 架構圖與失敗情境示範、蝦皮開放平台沙盒轉接器（Momo 無公開 API，維持 CSV 匯入）

## 授權

MIT
