export type PropType = 'number' | 'string' | 'bool';
export type PropValue = number | boolean | string;

// One property filter, sent to Traderie as a query param and re-checked on every returned listing.
// `id` and `name` come from the item's property schema (GET alerts/props)
export type Condition =
  | { id: number; name: string; type: 'number'; min?: number; max?: number }
  | { id: number; name: string; type: 'string'; values: string[] }
  | { id: number; name: string; type: 'bool'; value: boolean };

export interface Alert {
  id: number;
  item: string;
  // Traderie's item id; listings are fetched by it, so other items can't crowd the page out
  item_id: number;
  ladder: boolean;
  mode: 'sc' | 'hc';
  // Same unit as this combo's price_values
  max_value: number;
  conditions: Condition[];
  // See RECIPIENT; empty means the default LINE_ALERT_TO
  recipients: string[];
}

// The channel is told by the recipient's form, so one alert can mix them
export const RECIPIENT = {
  // user / group / room id
  line: /^[UCR][0-9a-f]{32}$/,
  // tg:<chat id> or tg:@channel
  telegram: /^tg:(-?\d+|@\w{5,})$/,
  discord: /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d+\/[\w-]+$/,
};

export const channelOf = (to: string) =>
  (Object.keys(RECIPIENT) as (keyof typeof RECIPIENT)[]).find((k) => RECIPIENT[k].test(to));

// For logs: a Discord webhook URL is its own secret
export const recipientLabel = (to: string) =>
  channelOf(to) === 'discord' ? `discord webhook ${to.split('/')[5]}` : to;

// One message per recipient, holding every hit of the alerts they receive
export function byRecipient(hits: { to: string[]; text: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of hits) for (const to of h.to) out.set(to, [...(out.get(to) ?? []), h.text]);
  return out;
}

export interface RawListing {
  id?: string | number;
  // A string in listings fetched by item id
  item_id?: string | number;
  item?: { name?: string };
  prices?: { name?: string; quantity?: number; group?: number }[];
  properties?: { name?: string; property?: string; string?: string | null; number?: number | null; bool?: boolean | null }[];
}

// Traderie filters numbers by property id (prop_<id>Min / prop_<id>Max) but strings and bools by name
// (prop_<name>=a,b), the same params its own search sidebar sends
export function alertQuery(a: Pick<Alert, 'ladder' | 'mode' | 'conditions'>): string {
  const q = new URLSearchParams({
    prop_Platform: 'PC',
    prop_Mode: a.mode === 'hc' ? 'hardcore' : 'softcore',
    prop_Ladder: String(a.ladder),
  });
  for (const c of a.conditions) {
    if (c.type === 'number') {
      if (c.min !== undefined) q.set(`prop_${c.id}Min`, String(c.min));
      if (c.max !== undefined) q.set(`prop_${c.id}Max`, String(c.max));
    } else {
      q.set(`prop_${c.name}`, c.type === 'string' ? c.values.join(',') : String(c.value));
    }
  }
  return q.toString().replace(/\+/g, '%20');
}

// Cheapest price group's total value (different groups are alternatives the buyer picks from);
// null when no group can be valued, i.e. every group asks for something missing from `values`
export function listingValue(l: RawListing, values: Map<string, number>): number | null {
  const groups = new Map<number, number | null>();
  for (const p of l.prices ?? []) {
    const g = p.group ?? 0;
    const sum = groups.has(g) ? groups.get(g)! : 0;
    const v = values.get(p.name ?? '');
    groups.set(g, sum === null || v === undefined ? null : sum + v * (p.quantity ?? 1));
  }
  const valued = [...groups.values()].filter((v): v is number => v !== null);
  return valued.length ? Math.min(...valued) : null;
}

export function listingProps(l: RawListing): Record<string, PropValue | null> {
  const out: Record<string, PropValue | null> = {};
  for (const p of l.properties ?? []) out[p.name ?? p.property ?? ''] = p.string ?? p.number ?? p.bool ?? null;
  return out;
}

function meets(c: Condition, have: PropValue | null | undefined): boolean {
  if (c.type === 'number') {
    return typeof have === 'number' && (c.min === undefined || have >= c.min) && (c.max === undefined || have <= c.max);
  }
  return c.type === 'string' ? c.values.includes(have as string) : have === c.value;
}

// The listing's value when it satisfies the alert, else null. Traderie already filtered by the same
// conditions; checking again guards against it silently ignoring a param
export function matchAlert(a: Alert, l: RawListing, values: Map<string, number>): number | null {
  if (l.item_id !== undefined && String(l.item_id) !== String(a.item_id)) return null;
  const props = listingProps(l);
  // Traderie's prop_Ladder=false filter also returns listings without a Ladder prop
  if (props.Ladder !== a.ladder || props.Mode !== (a.mode === 'hc' ? 'hardcore' : 'softcore')) return null;
  if (!a.conditions.every((c) => meets(c, props[c.name]))) return null;
  const value = listingValue(l, values);
  return value !== null && value <= a.max_value ? value : null;
}

export interface PropStat {
  name: string;
  type: PropType;
  // Share of listings that have it, 0..1
  rate: number;
  min?: number;
  median?: number;
  max?: number;
  // Most common first
  values?: string[];
}

// Set by the alert itself or meaningless as a condition
export const NOT_CONDITIONS = new Set(['Mode', 'Ladder', 'Platform', 'Game version']);

// Which properties sellers fill in for an item, most common first
export function summarizeProps(listings: Record<string, PropValue | null>[]): PropStat[] {
  const stats = new Map<string, { type: PropType; nums: number[]; vals: Map<string, number>; n: number }>();
  for (const props of listings) {
    for (const [name, v] of Object.entries(props)) {
      if (v === null || NOT_CONDITIONS.has(name)) continue;
      const type: PropType = typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : 'string';
      const s = stats.get(name) ?? { type, nums: [] as number[], vals: new Map<string, number>(), n: 0 };
      s.n++;
      if (typeof v === 'number') s.nums.push(v);
      else s.vals.set(String(v), (s.vals.get(String(v)) ?? 0) + 1);
      stats.set(name, s);
    }
  }
  return [...stats.entries()].sort((a, b) => b[1].n - a[1].n).map(([name, s]) => {
    const stat: PropStat = { name, type: s.type, rate: s.n / listings.length };
    if (s.nums.length) {
      const a = s.nums.sort((x, y) => x - y);
      Object.assign(stat, { min: a[0], median: a[Math.floor(a.length / 2)], max: a[a.length - 1] });
    }
    if (s.vals.size) stat.values = [...s.vals.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([v]) => v);
    return stat;
  });
}

export interface SchemaProp { id: number; name: string; type: string; options?: string[] | null }

export interface PropDef {
  id: number;
  name: string;
  type: PropType;
  // Every value Traderie accepts, for string properties
  options?: string[];
  // How sellers actually fill it in; absent when no sampled listing has it
  stat?: Omit<PropStat, 'name' | 'type'>;
}

// The item's filterable properties from Traderie's schema, annotated with seller stats; the ones sellers
// use come first (most common first), the rest by name
export function propCatalog(schema: SchemaProp[], stats: PropStat[]): PropDef[] {
  const byName = new Map(stats.map(({ name, type, ...s }) => [name, s]));
  return schema
    .filter((p) => !NOT_CONDITIONS.has(p.name) && ['number', 'string', 'bool'].includes(p.type))
    .map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type as PropType,
      ...(p.type === 'string' && p.options ? { options: p.options } : {}),
      ...(byName.has(p.name) ? { stat: byName.get(p.name) } : {}),
    }))
    .sort((a, b) => (b.stat?.rate ?? 0) - (a.stat?.rate ?? 0) || a.name.localeCompare(b.name));
}
