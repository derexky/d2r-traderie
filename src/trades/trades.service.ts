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
  item_ref: string | null;
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
        owner_uid      TEXT,
        item_ref       TEXT
      );
    `);
    // tables created by earlier versions lack the newer columns
    const cols = this.db.prepare('PRAGMA table_info(trades)').all() as { name: string }[];
    for (const col of ['owner_uid', 'item_ref']) {
      if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE trades ADD COLUMN ${col} TEXT`);
    }
  }

  findAll(filters: { category?: string; item_ref?: string }) {
    const entries = Object.entries(filters).filter(([, v]) => v !== undefined) as [string, string][];
    const where = entries.length ? `WHERE ${entries.map(([k]) => `${k} = ?`).join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM trades ${where} ORDER BY id DESC`).all(...entries.map(([, v]) => v));
  }

  create(t: NewTrade) {
    return this.db
      .prepare(
        `INSERT INTO trades (item_name, item_stats_raw, price, contact, category, owner_uid, item_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(t.item_name, t.item_stats_raw, t.price, t.contact, t.category, t.owner_uid, t.item_ref);
  }

  // false when the trade does not exist or belongs to someone else
  remove(id: number, owner_uid: string): boolean {
    return this.db.prepare('DELETE FROM trades WHERE id = ? AND owner_uid = ?').run(id, owner_uid).changes > 0;
  }
}
