import { DatabaseSync } from 'node:sqlite';

// Keep only the newest snapshot per item/combo
const db = new DatabaseSync(process.env.DB_PATH ?? 'data/traderie.db');
const { changes } = db.prepare(`
  DELETE FROM price_snapshots WHERE id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY item, combo ORDER BY synced_at DESC) AS rn
      FROM price_snapshots
    ) WHERE rn = 1
  )`).run();
console.log(`Deleted ${changes} old snapshots`);
