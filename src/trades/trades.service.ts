import { Injectable, OnModuleInit } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface NewTrade {
  item_name: string;
  item_stats_raw: string | null;
  price: string;
  contact: string;
  category: string | null;
  owner_uid: string;
}

// Player trade listings from d2r-fe, kept here because this DB lives on a persistent volume
@Injectable()
export class TradesService implements OnModuleInit {
  private db!: DatabaseSync;

  onModuleInit() {
    const path = process.env.DB_PATH ?? 'data/traderie.db';
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS trades (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        item_name      TEXT NOT NULL,
        item_stats_raw TEXT,
        price          TEXT NOT NULL,
        contact        TEXT NOT NULL,
        category       TEXT,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        owner_uid      TEXT
      );
    `);
    // tables created before accounts existed have no owner column
    const cols = this.db.prepare('PRAGMA table_info(trades)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'owner_uid')) this.db.exec('ALTER TABLE trades ADD COLUMN owner_uid TEXT');
  }

  findAll(category?: string) {
    return category === undefined
      ? this.db.prepare('SELECT * FROM trades ORDER BY id DESC').all()
      : this.db.prepare('SELECT * FROM trades WHERE category = ? ORDER BY id DESC').all(category);
  }

  create(t: NewTrade) {
    return this.db
      .prepare(
        `INSERT INTO trades (item_name, item_stats_raw, price, contact, category, owner_uid)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(t.item_name, t.item_stats_raw, t.price, t.contact, t.category, t.owner_uid);
  }

  // false when the trade does not exist or belongs to someone else
  remove(id: number, owner_uid: string): boolean {
    return this.db.prepare('DELETE FROM trades WHERE id = ? AND owner_uid = ?').run(id, owner_uid).changes > 0;
  }
}
