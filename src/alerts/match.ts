export type PropRule = number | boolean | string;

export interface Alert {
  id: number;
  item: string;
  ladder: boolean;
  mode: 'sc' | 'hc';
  // Same unit as the price_values table
  max_value: number;
  // Property name exactly as Traderie spells it, e.g. "+{{value}}% Enhanced Defense".
  // A number is a minimum; anything else must match exactly
  props: Record<string, PropRule>;
}

export interface RawListing {
  id?: string | number;
  item?: { name?: string };
  prices?: { name?: string; quantity?: number; group?: number }[];
  properties?: { name?: string; property?: string; string?: string | null; number?: number | null; bool?: boolean | null }[];
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

export function listingProps(l: RawListing): Record<string, PropRule | null> {
  const out: Record<string, PropRule | null> = {};
  for (const p of l.properties ?? []) out[p.name ?? p.property ?? ''] = p.string ?? p.number ?? p.bool ?? null;
  return out;
}

// The listing's value when it satisfies the alert, else null
export function matchAlert(a: Alert, l: RawListing, values: Map<string, number>): number | null {
  if (l.item?.name !== a.item) return null;
  const props = listingProps(l);
  // Traderie's prop_Ladder=false filter also returns listings without a Ladder prop
  if (props.Ladder !== a.ladder || props.Mode !== (a.mode === 'hc' ? 'hardcore' : 'softcore')) return null;
  for (const [name, want] of Object.entries(a.props)) {
    const have = props[name];
    if (typeof want === 'number' ? !(typeof have === 'number' && have >= want) : have !== want) return null;
  }
  const value = listingValue(l, values);
  return value !== null && value <= a.max_value ? value : null;
}
