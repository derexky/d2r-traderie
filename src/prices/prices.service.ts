import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as admin from 'firebase-admin';
import { TRACKED_ITEMS } from './tracked-items';

type Mode = 'sc' | 'hc';

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

interface TradeWindow {
  earliest: admin.firestore.Timestamp | null;
  latest:   admin.firestore.Timestamp | null;
}

// Stored in price_listings/{item}/{comboKey}/{listing_id}
interface StoredListing {
  id: string;
  completed_at: admin.firestore.Timestamp | null;
  prices: PriceItem[];
  props: Record<string, string | number | boolean | null>;
}

@Injectable()
export class PricesService implements OnModuleInit {
  private readonly log = new Logger(PricesService.name);
  private db: admin.firestore.Firestore | null = null;
  private syncing = false;

  onModuleInit() {
    try {
      if (!admin.apps.length) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sa = require(require('path').join(process.cwd(), 'serviceAccount.json'));
        admin.initializeApp({ credential: admin.credential.cert(sa) });
      }
      this.db = admin.firestore();
    } catch {
      this.log.warn('serviceAccount.json not found — price sync disabled');
    }
  }

  @Cron(CronExpression.EVERY_30_MINUTES)
  async syncAll() {
    if (!this.db || this.syncing) return;
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
        completed_at: ts && !isNaN(ts) ? admin.firestore.Timestamp.fromMillis(ts) : null,
        prices: (listing.prices ?? [])
          .filter((p) => p.name)
          .map((p) => ({ name: p.name!, quantity: p.quantity ?? 1, group: p.group ?? 0 })),
        props: extractProps(listing),
      });
    }

    const logParts: string[] = [];
    for (const [key, newListings] of Object.entries(groups)) {
      // Upsert to persistent store using listing id as doc id (natural dedup)
      if (newListings.length > 0) {
        const upsertBatch = this.db!.batch();
        for (const listing of newListings) {
          const ref = this.db!.collection('price_listings').doc(item).collection(key).doc(listing.id);
          upsertBatch.set(ref, listing);
        }
        await upsertBatch.commit();
      }

      // Read all deduplicated listings
      const MAX_LISTINGS = 500;
      const allSnap = await this.db!.collection('price_listings').doc(item).collection(key).get();
      let allDocs = allSnap.docs;

      // Trim to MAX_LISTINGS, deleting oldest by completed_at
      if (allDocs.length > MAX_LISTINGS) {
        const sorted = [...allDocs].sort((a, b) => {
          const aMs = (a.data() as StoredListing).completed_at?.toMillis() ?? 0;
          const bMs = (b.data() as StoredListing).completed_at?.toMillis() ?? 0;
          return aMs - bMs;
        });
        const toDelete = sorted.slice(0, allDocs.length - MAX_LISTINGS);
        const trimBatch = this.db!.batch();
        toDelete.forEach((d) => trimBatch.delete(d.ref));
        await trimBatch.commit();
        allDocs = sorted.slice(allDocs.length - MAX_LISTINGS);
      }

      const allListings = allDocs.map((d) => d.data() as StoredListing);

      await this.db!.collection('price_snapshots').doc(item).collection(key).add({
        synced_at: admin.firestore.FieldValue.serverTimestamp(),
        price: calcPrice(allListings),
        trade_window: calcWindow(allListings),
      });

      logParts.push(`${key}=${newListings.length}(total:${allListings.length})`);
    }

    this.log.log(`Synced [${item}] ${logParts.join(' ')}`);
  }

  async triggerSync(): Promise<void> {
    void this.syncAll();
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function comboKey(c: Combo) {
  return `${c.ladder ? 'ladder' : 'nonladder'}_${c.mode}`;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawProp {
  property: string;
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

const COMBO_PROP_KEYS = new Set(['Mode', 'Ladder', 'Platform', 'Game version']);

function extractProps(listing: RawListing): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  for (const p of listing.properties ?? []) {
    if (COMBO_PROP_KEYS.has(p.property)) continue;
    result[p.property] = p.string ?? p.number ?? (p.bool !== null && p.bool !== undefined ? p.bool : null);
  }
  return result;
}

function extractCombo(listing: RawListing): { mode: Mode; ladder: boolean } | null {
  const props = listing.properties ?? [];
  const modeProp   = props.find((p) => p.property === 'Mode');
  const ladderProp = props.find((p) => p.property === 'Ladder');
  const platform   = props.find((p) => p.property === 'Platform');
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
    .map((l) => l.completed_at?.toMillis() ?? null)
    .filter((t): t is number => t !== null);
  if (!millis.length) return { earliest: null, latest: null };
  return {
    earliest: admin.firestore.Timestamp.fromMillis(Math.min(...millis)),
    latest:   admin.firestore.Timestamp.fromMillis(Math.max(...millis)),
  };
}
