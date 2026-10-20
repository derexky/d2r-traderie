// Run after a build: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Alert, RawListing, alertQuery, listingValue, matchAlert, propCatalog, summarizeProps } from './match.js';

const listing = (prices: RawListing['prices'], props: [string, unknown][] = []): RawListing => ({
  id: 1,
  item_id: 7,
  prices,
  properties: [
    { name: 'Mode', string: 'softcore' },
    { name: 'Ladder', bool: true },
    ...props.map(([name, v]) => ({ name, ...(typeof v === 'number' ? { number: v } : typeof v === 'boolean' ? { bool: v } : { string: v as string }) })),
  ],
});

const values = new Map([['Vex Rune', 0.5], ['Ist Rune', 0.16], ['Mal Rune', 0.1], ['Ber Rune', 3.5]]);

const FCR = '+{{value}}% Faster Cast Rate';
const BASE = 'Base Item (Shield, Sword) 4';
const alert: Alert = {
  id: 1, item: 'Spirit', item_id: 7, ladder: true, mode: 'sc', max_value: 1,
  conditions: [
    { id: 520, name: FCR, type: 'number', min: 35 },
    { id: 1197, name: BASE, type: 'string', values: ['Monarch', 'Phase Blade'] },
    { id: 738, name: 'Ethereal', type: 'bool', value: false },
  ],
};

test('alertQuery: numbers by id, strings and bools by name', () => {
  assert.equal(
    decodeURIComponent(alertQuery({ ...alert, conditions: [...alert.conditions, { id: 400, name: 'Mana', type: 'number', min: 100, max: 112 }] })),
    'prop_Platform=PC&prop_Mode=softcore&prop_Ladder=true&prop_520Min=35&prop_Base Item (Shield, Sword) 4=Monarch,Phase Blade'
      + '&prop_Ethereal=false&prop_400Min=100&prop_400Max=112',
  );
  // spaces must be %20, not +
  assert.ok(alertQuery(alert).includes('prop_Base%20Item'));
});

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
  const ok: [string, unknown][] = [[FCR, 35], [BASE, 'Monarch'], ['Ethereal', false]];
  const vex = [{ name: 'Vex Rune' }];
  assert.equal(matchAlert(alert, listing(vex, ok), values), 0.5);
  assert.equal(matchAlert(alert, listing([{ name: 'Vex Rune', quantity: 3 }], ok), values), null, 'too expensive');
  assert.equal(matchAlert(alert, listing(vex, [[FCR, 30], [BASE, 'Monarch'], ['Ethereal', false]]), values), null, 'below min');
  assert.equal(matchAlert(alert, listing(vex, [[BASE, 'Monarch'], ['Ethereal', false]]), values), null, 'number missing');
  assert.equal(matchAlert(alert, listing(vex, [[FCR, 35], [BASE, 'Aegis'], ['Ethereal', false]]), values), null, 'other base');
  assert.equal(matchAlert(alert, listing(vex, [[FCR, 35], [BASE, 'Monarch'], ['Ethereal', true]]), values), null, 'ethereal');
  assert.equal(matchAlert({ ...alert, ladder: false }, listing(vex, ok), values), null, 'wrong ladder');
  assert.equal(matchAlert({ ...alert, item_id: 8 }, listing(vex, ok), values), null, 'other item');
  assert.equal(matchAlert(alert, { ...listing(vex, ok), item_id: '7' }, values), 0.5, 'item id as string');
  const capped: Alert = { ...alert, conditions: [{ id: 520, name: FCR, type: 'number', max: 30 }] };
  assert.equal(matchAlert(capped, listing(vex, [[FCR, 25]]), values), 0.5, 'max only');
  assert.equal(matchAlert(capped, listing(vex, [[FCR, 35]]), values), null, 'above max');
});

test('summarizeProps', () => {
  const stats = summarizeProps([
    { [FCR]: 35, Ethereal: true, Ladder: true, [BASE]: 'Monarch' },
    { [FCR]: 25, [BASE]: 'Monarch' },
    { [FCR]: 30, [BASE]: 'Phase Blade', Mode: 'softcore' },
    { 'Game version': 'x', Ethereal: null },
  ]);
  assert.deepEqual(stats, [
    { name: FCR, type: 'number', rate: 0.75, min: 25, median: 30, max: 35 },
    { name: BASE, type: 'string', rate: 0.75, values: ['Monarch', 'Phase Blade'] },
    { name: 'Ethereal', type: 'bool', rate: 0.25, values: ['true'] },
  ]);
});

test('propCatalog: schema with stats, used ones first, combo props dropped', () => {
  const catalog = propCatalog(
    [
      { id: 400, name: 'Mana', type: 'number', options: null },
      { id: 520, name: FCR, type: 'number' },
      { id: 1197, name: BASE, type: 'string', options: ['Monarch', 'Aegis'] },
      { id: 800, name: 'Ladder', type: 'bool' },
      { id: 999, name: 'Some Date', type: 'date' },
    ],
    [{ name: FCR, type: 'number', rate: 0.9, min: 25, median: 35, max: 35 }],
  );
  assert.deepEqual(catalog, [
    { id: 520, name: FCR, type: 'number', stat: { rate: 0.9, min: 25, median: 35, max: 35 } },
    { id: 1197, name: BASE, type: 'string', options: ['Monarch', 'Aegis'] },
    { id: 400, name: 'Mana', type: 'number' },
  ]);
});
