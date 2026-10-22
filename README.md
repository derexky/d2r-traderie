# d2r-traderie

易牙居 Diablo II: Resurrected 價格爬蟲服務，從 Traderie 抓取交易資料並寫入本地 SQLite，對外提供查價 API。

## 功能

- 定期爬取 Traderie 上的 D2R 交易列表
- 統計各物品成交價格分布，寫入 SQLite `price_snapshots` 表（保留歷史）
- 支援 Ladder / Non-Ladder、SC / HC 四種模式

## 技術棧

- **框架**：NestJS + TypeScript
- **資料庫**：SQLite（Node 內建 `node:sqlite`，需 Node ≥ 22.13），路徑由 `DB_PATH` 指定，預設 `data/traderie.db`
- **部署**：Cloud Run（asia-east1）

## API

- `GET /api/prices/items` — 有快照的物品清單
- `GET /api/prices/latest?item=&ladder=true|false&mode=sc|hc` — 最新快照
- `GET /api/prices/history?item=&ladder=&mode=&limit=24` — 歷史快照（最多 168 筆）

設定 `API_TOKEN` 時所有 API 都需帶 `x-api-token` header（myhost 放在 `~/d2r-traderie.env`，以 `--env-file` 傳入）。

時間欄位沿用 Firestore Timestamp 序列化格式 `{ _seconds, _nanoseconds }`。

## Traderie 登入

成交紀錄（`completed=true`）需要登入，否則 API 回 401。登入狀態存在 `data/traderie-auth.json`（`TRADERIE_AUTH` 可改路徑），服務啟動時載入並自動回存。過期時在本機重新產生：

```bash
node scripts/login.ts            # 開 Chrome 手動登入後按 Enter
ssh myhost 'cat > ~/d2r-traderie-data/traderie-auth.json' < data/traderie-auth.json  # myhost 不支援 scp
```

## 追蹤物品

清單存在 SQLite 的 `tracked_items` 表，用 d2r-admin 的「TR 價格追蹤物品」頁新增／修改／移除（API：`GET/POST /api/prices/tracked`、`PATCH/DELETE /api/prices/tracked/:name`），不用重新部署。新增時會先到 traderie 成交紀錄比對英文名稱（不分大小寫，存成 traderie 的寫法，查不到就拒絕），再立即爬一次該物品（若有同步正在跑則等下一輪）。`src/prices/tracked-items.ts` 只是表第一次建立時灌入的初始清單。

## 低價通知

用 d2r-admin 的「TR 低價通知」頁設定「物品＋屬性條件＋目標價」（`price_alerts` 表）。每 5 分鐘把每筆通知的條件組成 Traderie 的查詢參數，抓該物品**掛賣中**列表第一頁（由 Traderie 篩選，回來的都是符合條件的單），本機再驗一次條件、換算價格（一張單賣多個的按每個單價算），≤ 目標就推 LINE（同一輪合併成一則，同一張單對同一收件人只通知一次，紀錄在 `alert_hits`）。

- 價格換算用 `price_values` 表（d2r-admin「TR 物品價值」頁），Ladder/NL × SC/HC 每種組合各一套，通知用自己組合的那套：一組價格 = Σ 價值 × 數量，多組擇一取最便宜；不在表內的物品無法換算，該組略過。表第一次建立時四個組合都灌入 2026-10 的 Traderie Ladder SC 估價（Fal～Zod 符文），之後只看這張表
- 通知用獨立的匿名 Chrome context 抓掛賣列表（不需登入），跟查價用的登入頁面分開，出錯重開時互不影響；第一次用到時才會開啟
- API（都在 `/api/prices` 下，d2r-service 的 `/api/admin/alerts`、`/api/admin/values` 原樣轉發）：
  - `GET /alerts/props?item=`：物品能篩選的所有屬性（id、名稱、類型、文字選項），附賣家實際填寫的出現率與值範圍（追蹤物品取已存的成交紀錄，其他即時抓最新一頁掛賣單）
  - `GET/POST /alerts`、`PATCH/DELETE /alerts/:id`、`POST /alerts/check`（手動跑一次）
  - `GET /values`、`PUT/DELETE /values/:combo/:name`（combo = `ladder_sc`／`nonladder_sc`／`ladder_hc`／`nonladder_hc`）
- 收件人：每筆通知各自設定（`recipients`，可多個、可混用），依格式判斷管道；同一輪同一收件人的命中合併成一則。沒設就推給 `LINE_ALERT_TO`。`alert_hits` 按收件人分開記錄：推送失敗的收件人下次重推，其他人不會重複收到；新加入的收件人會收到目前仍符合的單
  - LINE：userId／groupId／roomId（`U`／`C`／`R` + 32 碼）。LINE 不提供頁面查別人的 id，由 d2r-linebot 在每次互動時呼叫 `POST /contacts`（`{ id, type, name }`）記進 `line_contacts` 表，`GET /contacts` 列出（d2r-admin「LINE 好友／群組」頁、通知收件人下拉選單）
  - Telegram：`tg:<chat id>` 或 `tg:@頻道名稱`（bot 要先在對話裡）
  - Discord：頻道的 Webhook URL（`https://discord.com/api/webhooks/...`）
- 環境變數：`LINE_CHANNEL_ACCESS_TOKEN`（與 d2r-linebot 同一個）、`LINE_ALERT_TO`（預設收件人的 LINE userId）、`TELEGRAM_BOT_TOKEN`（用到 Telegram 才需要）

### Traderie 屬性篩選參數

從 Traderie 前端程式與實測整理，`GET /api/diablo2resurrected/listings` 可加：

| 屬性類型 | 參數 | 例 |
|---|---|---|
| 數字 下限／上限 | `prop_<屬性id>Min`、`prop_<屬性id>Max`（用 **id**，用名稱無效） | `prop_520Min=35`（FCR ≥ 35） |
| 文字 | `prop_<屬性名稱>=值1,值2`（任一符合） | `prop_Base Item (Shield, Sword) 4=Monarch,Phase Blade` |
| 布林 | `prop_<屬性名稱>=true/false` | `prop_Ethereal=true` |
| 指定物品 | `item=<物品id>`（不用 `search` 模糊搜尋；回來的單沒有 `item` 物件，`item_id` 是字串） | `item=3588456322` |

- 屬性 id 全站共用（同一屬性在不同物品 id 相同）；物品可篩的屬性清單：`GET /api/diablo2resurrected/items?id=<slug>&properties=`（`properties=` 必帶；slug 取自掛單的 `item.slug`，如 `griffons-eye`）
- 加了數字條件，沒填該屬性的單也會被排除
- 參數要 URL encode（空格用 `%20`）

## 開發

```bash
npm install
npm run start:dev
```

## 部署

跑在 myhost（QNAP NAS）的 Docker 容器 `d2r-traderie`，由同一台的 `cloudflared` 對外提供 `https://traderie.derexky.com`。
步驟（同步原始碼 → NAS 上建置 image → 以相同設定重建容器 → 驗證）見 Claude Code skill `deploy-traderie-myhost`。

- 原始碼：`/share/homes/derexky/d2r-traderie`（不是 git repo，`.deployed-commit` 記錄已部署的 commit）
- 資料：`/share/CACHEDEV1_DATA/homes/derexky/d2r-traderie-data` → `/app/data`
- 環境變數：`/share/homes/derexky/d2r-traderie.env`（`API_TOKEN`）

`fly.toml` 與 Cloud Run 是舊的部署方式，已不使用。
