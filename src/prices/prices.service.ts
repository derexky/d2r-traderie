import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TRACKED_ITEMS } from './tracked-items';

export type Mode = 'sc' | 'hc';

interface Combo { ladder: boolean; mode: Mode }

interface PriceItem {
  name: string;
  quantity: number;
  group: number;
}

interface PriceSummary {
  count: number;
  top: Array<{ items: PriceItem[]; freq: number }>;
}

// Same shape as a serialized Firestore Timestamp, so existing consumers keep working
export interface Ts { _seconds: number; _nanoseconds: number }

interface TradeWindow {
  earliest: Ts | null;
  latest:   Ts | null;
}

// completed_at is epoch millis
interface StoredListing {
  id: string;
  completed_at: number | null;
  prices: PriceItem[];
  props: Record<string, string | number | boolean | null>;
}

@Injectable()
export class PricesService implements OnModuleInit {
  private readonly log = new Logger(PricesService.name);
  private db!: DatabaseSync;
  private syncing = false;

  onModuleInit() {
    const path = process.env.DB_PATH ?? 'data/traderie.db';
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS price_listings (
        item         TEXT NOT NULL,
        combo        TEXT NOT NULL,
        id           TEXT NOT NULL,
        completed_at INTEGER,
        prices       TEXT NOT NULL,
        props        TEXT NOT NULL,
        PRIMARY KEY (item, combo, id)
      );
      CREATE TABLE IF NOT EXISTS price_snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        item         TEXT NOT NULL,
        combo        TEXT NOT NULL,
        synced_at    INTEGER NOT NULL,
        price        TEXT NOT NULL,
        trade_window TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots ON price_snapshots (item, combo, synced_at DESC);
    `);
    this.log.log(`SQLite opened at ${path}`);
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncAll() {
    if (this.syncing) return;
    this.syncing = true;
    this.log.log(`Starting price sync: ${TRACKED_ITEMS.length} items`);
    try {
      for (const item of TRACKED_ITEMS) {
        try {
          await this.syncItem(item);
        } catch (err) {
          this.log.error(`Failed [${item}]: ${(err as Error).message}`);
        }
        await delay(5000);
      }
    } finally {
      this.syncing = false;
    }
    this.log.log('Price sync complete');
  }

  private async syncItem(item: string) {
    const fetchPage = async (page: number) => {
      const res = await fetch(
        `http://localhost:7432/api/traderie/completed?search=${encodeURIComponent(item)}&page=${page}`,
        { headers: { 'x-api-token': process.env.API_TOKEN ?? '' } },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return ((await res.json()) as { listings?: RawListing[] }).listings ?? [];
    };

    const page1 = await fetchPage(1);
    await delay(3000);
    const page2 = await fetchPage(2);

    // Merge and deduplicate by listing id
    const seen = new Set<string>();
    const listings: RawListing[] = [];
    for (const l of [...page1, ...page2]) {
      const id = String(l.id);
      if (!seen.has(id)) { seen.add(id); listings.push(l); }
    }

    // Convert and group by combo using listing properties
    const groups: Record<string, StoredListing[]> = {
      ladder_sc: [], ladder_hc: [], nonladder_sc: [], nonladder_hc: [],
    };
    for (const listing of listings) {
      const combo = extractCombo(listing);
      if (!combo) continue;
      const ts = listing.updated_at ? new Date(listing.updated_at).getTime() : null;
      groups[comboKey(combo)].push({
        id: String(listing.id),
        completed_at: ts && !isNaN(ts) ? ts : null,
        prices: (listing.prices ?? [])
          .filter((p) => p.name)
          .map((p) => ({ name: p.name!, quantity: p.quantity ?? 1, group: p.group ?? 0 })),
        props: extractProps(listing),
      });
    }

    const MAX_LISTINGS = 500;
    const upsert = this.db.prepare(`
      INSERT INTO price_listings (item, combo, id, completed_at, prices, props) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (item, combo, id) DO UPDATE SET
        completed_at = excluded.completed_at, prices = excluded.prices, props = excluded.props`);
    // Keep only the newest MAX_LISTINGS by completed_at
    const trim = this.db.prepare(`
      DELETE FROM price_listings WHERE item = ? AND combo = ? AND id NOT IN (
        SELECT id FROM price_listings WHERE item = ? AND combo = ?
        ORDER BY COALESCE(completed_at, 0) DESC LIMIT ${MAX_LISTINGS})`);
    const selectAll = this.db.prepare(
      'SELECT id, completed_at, prices, props FROM price_listings WHERE item = ? AND combo = ?');
    const insertSnapshot = this.db.prepare(
      'INSERT INTO price_snapshots (item, combo, synced_at, price, trade_window) VALUES (?, ?, ?, ?, ?)');

    const logParts: string[] = [];
    for (const [key, newListings] of Object.entries(groups)) {
      this.db.exec('BEGIN');
      try {
        for (const l of newListings) {
          upsert.run(item, key, l.id, l.completed_at, JSON.stringify(l.prices), JSON.stringify(l.props));
        }
        trim.run(item, key, item, key);
        const allListings: StoredListing[] = selectAll.all(item, key).map((r: any) => ({
          id: r.id,
          completed_at: r.completed_at,
          prices: JSON.parse(r.prices),
          props: JSON.parse(r.props),
        }));
        insertSnapshot.run(item, key, Date.now(),
          JSON.stringify(calcPrice(allListings)), JSON.stringify(calcWindow(allListings)));
        this.db.exec('COMMIT');
        logParts.push(`${key}=${newListings.length}(total:${allListings.length})`);
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }

    this.log.log(`Synced [${item}] ${logParts.join(' ')}`);
  }

  async triggerSync(): Promise<void> {
    void this.syncAll();
  }

  getTrackedItems(): string[] {
    return this.db.prepare('SELECT DISTINCT item FROM price_snapshots ORDER BY item').all()
      .map((r: any) => r.item);
  }

  getHistory(item: string, ladder: boolean, mode: Mode, limit: number) {
    return this.db.prepare(`
      SELECT synced_at, price, trade_window FROM price_snapshots
      WHERE item = ? AND combo = ? ORDER BY synced_at DESC LIMIT ?`)
      .all(item, comboKey({ ladder, mode }), limit)
      .map((r: any) => ({
        synced_at: toTs(r.synced_at),
        price: JSON.parse(r.price),
        trade_window: JSON.parse(r.trade_window),
      }));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function comboKey(c: Combo) {
  return `${c.ladder ? 'ladder' : 'nonladder'}_${c.mode}`;
}

function toTs(ms: number): Ts {
  return { _seconds: Math.floor(ms / 1000), _nanoseconds: (ms % 1000) * 1e6 };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawProp {
  name?: string;
  property?: string; // older API field name, replaced by `name`
  string?: string | null;
  bool?: boolean | null;
  number?: number | null;
}

interface RawListing {
  id?: string | number;
  updated_at?: string;
  prices?: { name?: string; value?: number; quantity?: number; group?: number }[];
  properties?: RawProp[];
}

const propName = (p: RawProp) => p.name ?? p.property ?? '';

const COMBO_PROP_KEYS = new Set(['Mode', 'Ladder', 'Platform', 'Game version']);

function extractProps(listing: RawListing): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const p of listing.properties ?? []) {
    if (COMBO_PROP_KEYS.has(propName(p))) continue;
    result[propName(p)] = p.string ?? p.number ?? (p.bool !== null && p.bool !== undefined ? p.bool : null);
  }
  return result;
}

function extractCombo(listing: RawListing): { mode: Mode; ladder: boolean } | null {
  const props = listing.properties ?? [];
  const modeProp   = props.find((p) => propName(p) === 'Mode');
  const ladderProp = props.find((p) => propName(p) === 'Ladder');
  const platform   = props.find((p) => propName(p) === 'Platform');
  if (platform?.string && platform.string !== 'PC') return null;
  if (!modeProp || !ladderProp) return null;
  const mode: Mode = modeProp.string === 'hardcore' ? 'hc' : 'sc';
  const ladder = ladderProp.bool === true;
  return { mode, ladder };
}

function calcPrice(listings: StoredListing[]): PriceSummary {
  if (!listings.length) return { count: 0, top: [] };

  const freq = new Map<string, { items: PriceItem[]; freq: number }>();
  for (const listing of listings) {
    if (!listing.prices.length) continue;
    // Group items by group number — same group = AND bundle, different groups = OR alternatives
    const byGroup = new Map<number, PriceItem[]>();
    for (const item of listing.prices) {
      const g = item.group ?? 0;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(item);
    }
    for (const items of byGroup.values()) {
      const key = items.map((i) => `${i.name}×${i.quantity}`).join('+');
      if (freq.has(key)) {
        freq.get(key)!.freq++;
      } else {
        freq.set(key, { items, freq: 1 });
      }
    }
  }

  return {
    count: listings.length,
    top: [...freq.values()].sort((a, b) => b.freq - a.freq).slice(0, 10),
  };
}

function calcWindow(listings: StoredListing[]): TradeWindow {
  const millis = listings
    .map((l) => l.completed_at)
    .filter((t): t is number => t !== null);
  if (!millis.length) return { earliest: null, latest: null };
  return {
    earliest: toTs(Math.min(...millis)),
    latest:   toTs(Math.max(...millis)),
  };
}
