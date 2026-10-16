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
