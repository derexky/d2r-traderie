import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TraderieService } from '../traderie/traderie.service';
import { Alert, PropDef, RawListing, SchemaProp, alertQuery, byRecipient, channelOf, listingProps, matchAlert, propCatalog, recipientLabel, summarizeProps } from './match';

export type NewAlert = Omit<Alert, 'id'>;

// Same keys as the price snapshots: ladder_sc, nonladder_sc, ladder_hc, nonladder_hc
export const COMBOS = ['ladder_sc', 'nonladder_sc', 'ladder_hc', 'nonladder_hc'];
export const comboOf = (a: Pick<Alert, 'ladder' | 'mode'>) => `${a.ladder ? 'ladder' : 'nonladder'}_${a.mode}`;

export interface PriceValue { combo: string; name: string; value: number }

export interface LineContact { id: string; type: 'user' | 'group' | 'room'; name: string | null; seen_at: string }

export interface ItemRef { id: number; name: string; slug: string }

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
    // The first alerts matched property names locally and had no item id; their conditions can't be turned
    // into Traderie filters, so an empty table is replaced and a non-empty one set aside for re-entry
    // Hits used to be one per alert and listing, all pushed to LINE_ALERT_TO; they become that recipient's
    const hitCols = this.db.prepare('PRAGMA table_info(alert_hits)').all() as { name: string }[];
    const oneRecipientHits = hitCols.length > 0 && !hitCols.some((c) => c.name === 'recipient');
    if (oneRecipientHits) this.db.exec('ALTER TABLE alert_hits RENAME TO alert_hits_v1');
    const alertCols = this.db.prepare('PRAGMA table_info(price_alerts)').all() as { name: string }[];
    if (alertCols.length && !alertCols.some((c) => c.name === 'item_id')) {
      const rows = (this.db.prepare('SELECT COUNT(*) AS n FROM price_alerts').get() as { n: number }).n;
      this.db.exec(rows ? 'ALTER TABLE price_alerts RENAME TO price_alerts_v1' : 'DROP TABLE price_alerts');
      if (rows) this.log.warn(`Moved ${rows} old-format alerts to price_alerts_v1; re-create them in d2r-admin`);
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS price_alerts (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        item       TEXT NOT NULL,
        item_id    INTEGER NOT NULL,
        ladder     INTEGER NOT NULL,
        mode       TEXT NOT NULL,
        max_value  REAL NOT NULL,
        conditions TEXT NOT NULL,
        recipients TEXT NOT NULL DEFAULT '[]'
      );
      -- listings already notified, so each one is pushed once per alert and recipient
      CREATE TABLE IF NOT EXISTS alert_hits (
        alert_id   INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        recipient  TEXT NOT NULL,
        PRIMARY KEY (alert_id, listing_id, recipient)
      );
      -- what each currency item is worth per combo, in whatever unit that combo's alert prices are written in
      CREATE TABLE IF NOT EXISTS price_values (
        combo TEXT NOT NULL,
        name  TEXT NOT NULL,
        value REAL NOT NULL,
        PRIMARY KEY (combo, name)
      );
      -- LINE users and groups that talked to d2r-linebot, so their ids can be picked as alert recipients
      CREATE TABLE IF NOT EXISTS line_contacts (
        id      TEXT PRIMARY KEY,
        type    TEXT NOT NULL,
        name    TEXT,
        seen_at TEXT NOT NULL
      );
    `);
    if (!(this.db.prepare('PRAGMA table_info(price_alerts)').all() as { name: string }[]).some((c) => c.name === 'recipients')) {
      this.db.exec("ALTER TABLE price_alerts ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'");
    }
    if (oneRecipientHits) {
      this.db.prepare('INSERT INTO alert_hits SELECT alert_id, listing_id, ? FROM alert_hits_v1').run(process.env.LINE_ALERT_TO ?? '');
      this.db.exec('DROP TABLE alert_hits_v1');
    }
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

  listContacts(): LineContact[] {
    return this.db.prepare('SELECT * FROM line_contacts ORDER BY seen_at DESC').all() as any;
  }

  // Keeps the last known name when this one is missing (e.g. a profile lookup failed)
  saveContact(c: Omit<LineContact, 'seen_at'>) {
    this.db.prepare(`INSERT INTO line_contacts (id, type, name, seen_at) VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT (id) DO UPDATE SET type = excluded.type, name = COALESCE(excluded.name, name), seen_at = excluded.seen_at`)
      .run(c.id, c.type, c.name);
  }

  list(): Alert[] {
    return this.db.prepare('SELECT * FROM price_alerts ORDER BY id').all()
      .map((r: any) => ({ ...r, ladder: !!r.ladder, conditions: JSON.parse(r.conditions), recipients: JSON.parse(r.recipients) }));
  }

  add(a: NewAlert): Alert {
    const { id } = this.db.prepare(
      'INSERT INTO price_alerts (item, item_id, ladder, mode, max_value, conditions, recipients) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(a.item, a.item_id, a.ladder ? 1 : 0, a.mode, a.max_value, JSON.stringify(a.conditions), JSON.stringify(a.recipients)) as { id: number };
    return { id, ...a };
  }

  // Listings already notified stay notified, so tightening an alert doesn't repeat old hits; a newly added
  // recipient gets the listings that still match
  update(id: number, a: NewAlert): Alert | null {
    const changed = this.db.prepare(
      'UPDATE price_alerts SET item = ?, item_id = ?, ladder = ?, mode = ?, max_value = ?, conditions = ?, recipients = ? WHERE id = ?')
      .run(a.item, a.item_id, a.ladder ? 1 : 0, a.mode, a.max_value, JSON.stringify(a.conditions), JSON.stringify(a.recipients), id).changes;
    return changed ? { id, ...a } : null;
  }

  remove(id: number): boolean {
    this.db.prepare('DELETE FROM alert_hits WHERE alert_id = ?').run(id);
    return this.db.prepare('DELETE FROM price_alerts WHERE id = ?').run(id).changes > 0;
  }

  // The Traderie item an English name (any casing) or slug (e.g. grand-charm) refers to, with the newest
  // ladder SC selling listings of it (and its schema when already fetched); null when nothing matches.
  // Looking the slug up and listing by item id takes ~2 s; Traderie's name search can take 15-50 s
  private async resolve(search: string): Promise<{ item: ItemRef; listings: RawListing[]; schema?: SchemaProp[] } | null> {
    const lower = search.toLowerCase();
    const slug = lower.replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const found = await this.traderie.fetchItem(slug, 'alerts').catch(() => undefined);
    if (found?.id && found.name && found.slug && (found.name.toLowerCase() === lower || found.slug === lower)) {
      const item = { id: Number(found.id), name: found.name, slug: found.slug };
      const res = await this.traderie.fetchItemListings(item.id, alertQuery({ ladder: true, mode: 'sc', conditions: [] }), 'alerts') as {
        listings?: RawListing[];
      };
      return { item, listings: res.listings ?? [], schema: (found.properties ?? []) as SchemaProp[] };
    }
    // ponytail: name search fallback for names whose slug isn't the plain one; slow, but rare
    // a slug has no spaces; search it as words, since Traderie's search matches names
    const query = search.includes(' ') ? search : search.replace(/-/g, ' ');
    const res = await this.traderie.fetchListings(query, 0, { ladder: true, mode: 'sc' }, 'alerts') as {
      listings?: (RawListing & { item?: { id?: number; name?: string; slug?: string } })[];
    };
    const listings = (res.listings ?? []).filter((l) => l.item?.name?.toLowerCase() === lower || l.item?.slug === lower);
    const it = listings[0]?.item;
    return it?.id && it.name && it.slug ? { item: { id: it.id, name: it.name, slug: it.slug }, listings } : null;
  }

  async resolveItem(search: string): Promise<ItemRef | null> {
    return (await this.resolve(search))?.item ?? null;
  }

  // Every property Traderie can filter the item by (id, type, string options), annotated with how sellers
  // fill it in. Tracked items take those stats from their stored completed trades (hundreds, all combos);
  // others from the newest page of selling listings
  async propsOf(search: string): Promise<{ item: string; item_id: number; source: 'completed' | 'selling'; listings: number; props: PropDef[] } | null> {
    const found = await this.resolve(search);
    if (!found) return null;
    const { item, listings } = found;
    const schema = found.schema ?? await this.traderie.fetchItemSchema(item.slug, 'alerts') as SchemaProp[];
    const stored = (this.db.prepare('SELECT props FROM price_listings WHERE item = ?').all(item.name) as { props: string }[])
      .map((r) => JSON.parse(r.props));
    const sample = stored.length ? stored : listings.map(listingProps);
    return {
      item: item.name,
      item_id: item.id,
      source: stored.length ? 'completed' : 'selling',
      listings: sample.length,
      props: propCatalog(schema, summarizeProps(sample)),
    };
  }

  // ponytail: one fetch per alert, newest page only; Traderie already filters by the conditions, so that page
  // holds only candidates. Fetch more pages if hits start getting missed
  @Cron(CronExpression.EVERY_10_MINUTES)
  async check() {
    if (this.running) return;
    this.running = true;
    try {
      const hits: { alert: number; listing: string; to: string[]; text: string }[] = [];
      const seen = this.db.prepare('SELECT 1 FROM alert_hits WHERE alert_id = ? AND listing_id = ? AND recipient = ?');
      const fallback = process.env.LINE_ALERT_TO;
      const values = new Map(COMBOS.map((c) => [c, new Map<string, number>()]));
      for (const v of this.listValues()) values.get(v.combo)?.set(v.name, v.value);
      for (const a of this.list()) {
        try {
          const res = await this.traderie.fetchItemListings(a.item_id, alertQuery(a), 'alerts') as { listings?: RawListing[] };
          for (const l of res.listings ?? []) {
            const value = matchAlert(a, l, values.get(comboOf(a))!);
            if (value === null) continue;
            const all = a.recipients.length ? a.recipients : fallback ? [fallback] : [];
            if (!all.length) throw new Error('no recipients and LINE_ALERT_TO not set');
            const to = all.filter((r) => !seen.get(a.id, String(l.id), r));
            if (!to.length) continue;
            hits.push({ alert: a.id, listing: String(l.id), to, text: formatHit(a, l, value) });
          }
        } catch (err) {
          this.log.error(`Alert #${a.id} [${a.item}] failed: ${(err as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!hits.length) return;
      const failed = new Set<string>();
      for (const [to, texts] of byRecipient(hits)) {
        await notify(to, texts.join('\n\n')).catch((err: Error) => {
          failed.add(to);
          this.log.error(`Push to ${recipientLabel(to)} failed: ${err.message}`);
        });
      }
      // Only remember a hit for the recipients whose push went through, so a failed one is retried next run
      const insert = this.db.prepare('INSERT OR IGNORE INTO alert_hits (alert_id, listing_id, recipient) VALUES (?, ?, ?)');
      let sent = 0;
      for (const h of hits) {
        for (const to of h.to.filter((t) => !failed.has(t))) {
          insert.run(h.alert, h.listing, to);
          sent++;
        }
      }
      this.log.log(`Pushed ${sent} alert hit(s) to ${byRecipient(hits).size - failed.size} recipient(s)`);
    } catch (err) {
      this.log.error(`Alert check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}

function formatHit(a: Alert, l: RawListing, value: number): string {
  const price = (l.prices ?? []).map((p) => `${p.name}×${p.quantity ?? 1}${p.group ? ` (選項${p.group + 1})` : ''}`).join(', ');
  const props = listingProps(l);
  const stats = a.conditions.map(({ name }) =>
    (name.includes('{{value}}') ? name.replace('{{value}}', String(props[name])) : `${name}: ${props[name]}`)).join(' / ');
  return [
    `🔔 ${a.item} ${a.ladder ? 'Ladder' : 'NL'} ${a.mode.toUpperCase()}：${+value.toFixed(3)} ≤ ${a.max_value}`,
    (l.amount ?? 1) > 1 ? `${l.amount} 個共 ${price}` : price,
    stats,
    `https://traderie.com/diablo2resurrected/listing/${l.id}`,
  ].filter(Boolean).join('\n');
}

// Each channel caps a text message: LINE 5000 characters, Telegram 4096, Discord 2000
async function notify(to: string, text: string) {
  const channel = channelOf(to);
  const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`${name} not set; would push:\n${text}`);
    return v;
  };
  const [url, headers, body] =
    channel === 'telegram'
      ? [`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/sendMessage`, {},
        { chat_id: to.slice(3), text: text.slice(0, 4096), disable_web_page_preview: true }]
      : channel === 'discord'
        ? [to, {}, { content: text.slice(0, 2000) }]
        : ['https://api.line.me/v2/bot/message/push', { authorization: `Bearer ${env('LINE_CHANNEL_ACCESS_TOKEN')}` },
          { to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }];
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${channel ?? 'line'} push ${res.status}: ${await res.text()}`);
}
