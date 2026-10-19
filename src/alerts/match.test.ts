// Run after a build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Alert, RawListing, listingValue, matchAlert } from './match.js';

const listing = (prices: RawListing['prices'], props: [string, unknown][] = []): RawListing => ({
  id: 1,
  item: { name: 'Shako' },
  prices,
  properties: [
    { name: 'Mode', string: 'softcore' },
    { name: 'Ladder', bool: true },
    ...props.map(([name, v]) => ({ name, ...(typeof v === 'number' ? { number: v } : typeof v === 'boolean' ? { bool: v } : { string: v as string }) })),
  ],
});

const values = new Map([['Vex Rune', 0.5], ['Ist Rune', 0.16], ['Mal Rune', 0.1], ['Ber Rune', 3.5]]);

const alert: Alert = {
  id: 1, item: 'Shako', ladder: true, mode: 'sc', max_value: 1,
  props: { '+{{value}}% Enhanced Defense': 10, Rarity: 'superior' },
};

test('listingValue takes the cheapest group and multiplies quantity', () => {
  assert.equal(listingValue(listing([
    { name: 'Vex Rune', quantity: 3, group: 0 },
    { name: 'Ist Rune', quantity: 1, group: 1 },
    { name: 'Mal Rune', quantity: 1, group: 1 },
  ]), values), 0.26);
});

test('listingValue skips groups with an item missing from the value table', () => {
  assert.equal(listingValue(listing([{ name: 'Jewel', group: 0 }, { name: 'Ber Rune', group: 1 }]), values), 3.5);
  assert.equal(listingValue(listing([{ name: 'Jewel' }, { name: 'Ber Rune' }]), values), null, 'same group');
});

test('matchAlert', () => {
  const props: [string, unknown][] = [['+{{value}}% Enhanced Defense', 15], ['Rarity', 'superior']];
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune' }], props), values), 0.5);
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune', quantity: 3 }], props), values), null, 'too expensive');
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune' }], [['+{{value}}% Enhanced Defense', 5], ['Rarity', 'superior']]), values), null, 'stat below minimum');
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune' }], [['Rarity', 'superior']]), values), null, 'stat missing');
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune' }], [['+{{value}}% Enhanced Defense', 15], ['Rarity', 'rare']]), values), null, 'wrong rarity');
  assert.equal(matchAlert({ ...alert, ladder: false }, listing([{ name: 'Vex Rune' }], props), values), null, 'wrong ladder');
});
