import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TraderieService } from '../traderie/traderie.service';
import { Alert, RawListing, listingProps, matchAlert } from './match';

export type NewAlert = Omit<Alert, 'id'>;

// Same keys as the price snapshots: ladder_sc, nonladder_sc, ladder_hc, nonladder_hc
export const COMBOS = ['ladder_sc', 'nonladder_sc', 'ladder_hc', 'nonladder_hc'];
export const comboOf = (a: Pick<Alert, 'ladder' | 'mode'>) => `${a.ladder ? 'ladder' : 'nonladder'}_${a.mode}`;

export interface PriceValue { combo: string; name: string; value: number }

// Traderie's ladder SC valuation as of 2026-10, used for every combo when price_values is first created
const SEED_VALUES: [string, number][] = [
  ['Zod Rune', 0.9], ['Cham Rune', 0.4], ['Jah Rune', 3], ['Ber Rune', 3.5], ['Sur Rune', 1.75], ['Lo Rune', 1.25],
  ['Ohm Rune', 0.75], ['Vex Rune', 0.5], ['Gul Rune', 0.25], ['Ist Rune', 0.16], ['Mal Rune', 0.1], ['Um Rune', 0.06],
  ['Pul Rune', 0.04], ['Lem Rune', 0.02], ['Fal Rune', 0.01],
];

// Watches active (selling) listings and pushes a LINE message when one is at or below an alert's price
@Injectable()
export class AlertsService implements OnModuleInit {
  private readonly log = new Logger(AlertsService.name);
  private db!: DatabaseSync;
  private running = false;

  constructor(private readonly traderie: TraderieService) {}

  onModuleInit() {
    const path = process.env.DB_PATH ?? 'data/traderie.db';
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const seedValues = !this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'price_values'").get();
    // The first version had one value table for every combo; start each combo from a copy of it
    const oneTable = !seedValues && !(this.db.prepare('PRAGMA table_info(price_values)').all() as { name: string }[])
      .some((c) => c.name === 'combo');
    if (oneTable) this.db.exec('ALTER TABLE price_values RENAME TO price_values_old');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS price_alerts (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        item      TEXT NOT NULL,
        ladder    INTEGER NOT NULL,
        mode      TEXT NOT NULL,
        max_value REAL NOT NULL,
        props     TEXT NOT NULL
      );
      -- listings already notified, so each one is pushed once per alert
      CREATE TABLE IF NOT EXISTS alert_hits (
        alert_id   INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        PRIMARY KEY (alert_id, listing_id)
      );
      -- what each currency item is worth per combo, in whatever unit that combo's alert prices are written in
      CREATE TABLE IF NOT EXISTS price_values (
        combo TEXT NOT NULL,
        name  TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (combo, name)
      );
    `);
    if (oneTable) {
      const old = this.db.prepare('SELECT name, value FROM price_values_old').all() as { name: string; value: number }[];
      for (const combo of COMBOS) for (const v of old) this.setValue(combo, v.name, v.value);
      this.db.exec('DROP TABLE price_values_old');
    }
    if (seedValues) for (const combo of COMBOS) for (const [name, value] of SEED_VALUES) this.setValue(combo, name, value);
  }

  listValues(): PriceValue[] {
    return this.db.prepare('SELECT combo, name, value FROM price_values ORDER BY combo, value DESC').all() as any;
  }

  // Adds or updates; name must be the exact Traderie item name, e.g. "Ber Rune"
  setValue(combo: string, name: string, value: number) {
    this.db.prepare(`INSERT INTO price_values (combo, name, value) VALUES (?, ?, ?)
      ON CONFLICT (combo, name) DO UPDATE SET value = excluded.value`).run(combo, name, value);
  }

  removeValue(combo: string, name: string): boolean {
    return this.db.prepare('DELETE FROM price_values WHERE combo = ? AND name = ?').run(combo, name).changes > 0;
  }

  list(): Alert[] {
    return this.db.prepare('SELECT * FROM price_alerts ORDER BY id').all()
      .map((r: any) => ({ ...r, ladder: !!r.ladder, props: JSON.parse(r.props) }));
  }

  add(a: NewAlert): Alert {
    const { id } = this.db.prepare('INSERT INTO price_alerts (item, ladder, mode, max_value, props) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .get(a.item, a.ladder ? 1 : 0, a.mode, a.max_value, JSON.stringify(a.props)) as { id: number };
    return { id, ...a };
  }

  // Listings already notified stay notified, so tightening an alert doesn't repeat old hits
  update(id: number, a: NewAlert): Alert | null {
    const changed = this.db.prepare('UPDATE price_alerts SET item = ?, ladder = ?, mode = ?, max_value = ?, props = ? WHERE id = ?')
      .run(a.item, a.ladder ? 1 : 0, a.mode, a.max_value, JSON.stringify(a.props), id).changes;
    return changed ? { id, ...a } : null;
  }

  remove(id: number): boolean {
    this.db.prepare('DELETE FROM alert_hits WHERE alert_id = ?').run(id);
    return this.db.prepare('DELETE FROM price_alerts WHERE id = ?').run(id).changes > 0;
  }

  // Traderie's exact item name for a search (any casing), or null when no active listing matches it
  async resolveName(search: string): Promise<string | null> {
    const lower = search.toLowerCase();
    return (await this.fetch(search, { ladder: true, mode: 'sc' })).map((l) => l.item?.name)
      .find((n) => n?.toLowerCase() === lower) ?? null;
  }

  // ponytail: one fetch per alert, newest page only; group alerts by item/combo if the list grows large
  @Cron(CronExpression.EVERY_10_MINUTES)
  async check() {
    if (this.running) return;
    this.running = true;
    try {
      const hits: string[] = [];
      const seen = this.db.prepare('SELECT 1 FROM alert_hits WHERE alert_id = ? AND listing_id = ?');
      const record: [number, string][] = [];
      const values = new Map(COMBOS.map((c) => [c, new Map<string, number>()]));
      for (const v of this.listValues()) values.get(v.combo)?.set(v.name, v.value);
      for (const a of this.list()) {
        try {
          for (const l of await this.fetch(a.item, a)) {
            const value = matchAlert(a, l, values.get(comboOf(a))!);
            if (value === null || seen.get(a.id, String(l.id))) continue;
            hits.push(formatHit(a, l, value));
            record.push([a.id, String(l.id)]);
          }
        } catch (err) {
          this.log.error(`Alert #${a.id} [${a.item}] failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!hits.length) return;
      // Only remember hits once LINE accepted them, so a failed push is retried next run
      await pushLine(hits.join('\n\n'));
      const insert = this.db.prepare('INSERT OR IGNORE INTO alert_hits (alert_id, listing_id) VALUES (?, ?)');
      for (const [aid, lid] of record) insert.run(aid, lid);
      this.log.log(`Pushed ${hits.length} alert hit(s)`);
    } catch (err) {
      this.log.error(`Alert check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async fetch(search: string, combo: { ladder: boolean; mode: 'sc' | 'hc' }): Promise<RawListing[]> {
    const res = await this.traderie.fetchListings(search, 0, combo, 'alerts') as { listings?: RawListing[] };
    return res.listings ?? [];
  }
}

function formatHit(a: Alert, l: RawListing, value: number): string {
  const price = (l.prices ?? []).map((p) => `${p.name}×${p.quantity ?? 1}${p.group ? ` (選項${p.group + 1})` : ''}`).join(', ');
  const props = listingProps(l);
  const stats = Object.keys(a.props)
    .map((k) => (k.includes('{{value}}') ? k.replace('{{value}}', String(props[k])) : `${k}: ${props[k]}`)).join(' / ');
  return [
    `🔔 ${a.item} ${a.ladder ? 'Ladder' : 'NL'} ${a.mode.toUpperCase()}：${+value.toFixed(3)} ≤ ${a.max_value}`,
    price,
    stats,
    `https://traderie.com/diablo2resurrected/listing/${l.id}`,
  ].filter(Boolean).join('\n');
}

async function pushLine(text: string) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const to = process.env.LINE_ALERT_TO;
  if (!token || !to) throw new Error(`LINE_CHANNEL_ACCESS_TOKEN / LINE_ALERT_TO not set; would push:\n${text}`);
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    // LINE caps a text message at 5000 characters
    body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}: ${await res.text()}`);
}
