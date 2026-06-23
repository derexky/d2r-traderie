# d2r-traderie

易牙居 Diablo II: Resurrected 價格爬蟲服務，從 Traderie 抓取交易資料並寫入 Firestore。

## 功能

- 定期爬取 Traderie 上的 D2R 交易列表
- 統計各物品成交價格分布，寫入 Firestore `price_snapshots` collection
- 支援 Ladder / Non-Ladder、SC / HC 四種模式

## 技術棧

- **框架**：NestJS + TypeScript
- **資料庫**：Firestore（Firebase Admin SDK）
- **部署**：Cloud Run（asia-east1）

## 追蹤物品

清單維護於 `src/prices/tracked-items.ts`，新增物品時需同步更新 `d2r-linebot` 的同名檔案。

## 開發

```bash
npm install
npm run start:dev
```

## 部署

```bash
gcloud run deploy d2r-traderie --source . --project=d2r-diablo --region=asia-east1
```
