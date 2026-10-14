import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { chromium } from 'playwright';

// Run locally (macOS): log in to Traderie in the Chrome window that opens, then close the window.
// Copy the output file to the server's data/ dir (next to traderie.db).
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'data/traderie-auth.json';
const profile = resolve('data/chrome-login');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Same keychain Playwright uses, so it can decrypt the cookies afterwards
const FLAGS = ['--use-mock-keychain', '--no-first-run', '--no-default-browser-check'];

async function main() {
  // Plain Chrome (not driven by Playwright) so login pages don't flag it as automated
  if (!process.argv.includes('--export-only')) {
    console.log('Log in to Traderie in the Chrome window, then quit Chrome (⌘Q)...');
    spawnSync(CHROME, [`--user-data-dir=${profile}`, ...FLAGS, 'https://traderie.com/diablo2resurrected'], { stdio: 'ignore' });
  }

  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true, args: FLAGS });
  // storageState only includes localStorage of origins opened in this context
  await (await context.newPage()).goto('https://traderie.com/diablo2resurrected', { waitUntil: 'domcontentloaded' });
  const state = await context.storageState();
  await context.close();

  // Keep only Traderie's own state: drops Google/ad cookies, and cf_clearance is bound to this machine's IP
  state.cookies = state.cookies.filter((c) => /(^|\.)traderie\.com$/.test(c.domain) && c.name !== 'cf_clearance');
  state.origins = state.origins.filter((o) => new URL(o.origin).hostname.endsWith('traderie.com'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(state, null, 2));
  console.log(`Saved ${state.cookies.length} cookies, ${state.origins.length} origins → ${out}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
