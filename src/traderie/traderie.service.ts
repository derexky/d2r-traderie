import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { existsSync } from 'node:fs';
import { chromium, Browser, Page } from 'playwright';

const TRADERIE_HOME = 'https://traderie.com/diablo2resurrected';
// Logged-in session produced by scripts/login.ts; completed listings return 401 without it
const AUTH_STATE = process.env.TRADERIE_AUTH ?? 'data/traderie-auth.json';

export interface ListingFilters {
  mode?: 'hc' | 'sc';
  ladder?: boolean;
  ethereal?: boolean;
}

// 'main' is logged in and serves the price sync and the API; 'alerts' is anonymous (selling listings
// need no login) so price alerts never share a page, a re-open or the rotating login with the sync
export type SessionName = 'main' | 'alerts';

// One browser context with one page, re-opened on its own when it breaks
class Session {
  private page: Page | null = null;
  // An open in progress, so concurrent callers wait for it instead of opening a second context
  private opening: Promise<Page> | null = null;
  private hasAuth = false;
  // Bearer token the Traderie frontend attaches to its API calls, replayed on in-page fetches
  private authHeader: string | null = null;

  constructor(
    private readonly name: SessionName,
    private readonly browser: () => Browser,
    private readonly log: Logger,
  ) {}

  // Persist the session after every successful request so tokens Traderie rotates in-page survive restarts
  async saveAuth() {
    if (this.hasAuth) await this.page!.context().storageState({ path: AUTH_STATE });
  }

  async waitForCfChallenge(page: Page): Promise<void> {
    if ((await page.title()) === 'Just a moment...') {
      this.log.log(`[${this.name}] Waiting for Cloudflare challenge...`);
      await page.waitForFunction(
        () => document.title !== 'Just a moment...',
        { timeout: 30000 },
      );
    }
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<Page> {
    this.hasAuth = this.name === 'main' && existsSync(AUTH_STATE);
    if (this.name === 'main' && !this.hasAuth) this.log.warn(`${AUTH_STATE} not found — completed listings will return 401`);
    const context = await this.browser().newContext(this.hasAuth ? { storageState: AUTH_STATE } : {});
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await context.newPage();
    page.on('request', (r) => {
      const a = r.headers().authorization;
      if (a && r.url().includes('/api/')) this.authHeader = a;
    });
    this.log.log(`[${this.name}] Navigating to traderie.com...`);

    try {
      // Visit home first, then a search URL to establish cf_clearance for search paths
      await page.goto(TRADERIE_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitForCfChallenge(page);

      await page.goto(`${TRADERIE_HOME}?search=test`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitForCfChallenge(page);
    } catch (err) {
      await context.close();
      throw err;
    }

    const cookies = await context.cookies('https://traderie.com');
    const hasCf = cookies.some((c) => c.name === 'cf_clearance');
    this.log.log(`[${this.name}] cf_clearance set: ${hasCf}`);
    this.page = page;
    await this.saveAuth();

    this.log.log(`[${this.name}] Traderie page ready`);
    return page;
  }

  // Call the API from inside the page: reuses its Cloudflare clearance and session without a full
  // navigation, which is ~5x faster. On a Cloudflare block or a broken page, re-establish the page once
  async fetchApi(path: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const page = await this.getPage();
      const res = await page
        .evaluate(async ({ path, auth }) => {
          // Traderie occasionally never answers; abort so one stuck call can't stall the whole sync
          const r = await fetch(path, { headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(30000) });
          return { status: r.status, body: await r.text() };
        }, { path, auth: this.authHeader })
        .catch((err: Error) => ({ status: 0, body: err.message }));

      if (res.status === 401) {
        throw new UnauthorizedException(`Traderie session missing or expired — run scripts/login.ts and copy ${AUTH_STATE}`);
      }
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.body) as unknown;
          this.log.log(`[${this.name}] Fetched ${path} → 200`);
          await this.saveAuth();
          return data;
        } catch { /* HTML challenge page served with 200 — fall through to retry */ }
      }
      if (attempt > 0) throw new Error(`Traderie API ${res.status}: ${res.body.slice(0, 100)}`);
      this.log.warn(`[${this.name}] Traderie API ${res.status}, re-opening page and retrying`);
      await page.context().close();
    }
  }
}

@Injectable()
export class TraderieService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TraderieService.name);
  private browser: Browser | null = null;
  private readonly sessions: Record<SessionName, Session> = {
    main: new Session('main', () => this.browser!, this.log),
    // Opened on first use, so it costs nothing until an alert exists
    alerts: new Session('alerts', () => this.browser!, this.log),
  };

  async onModuleInit() {
    this.browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
    this.log.log('Chrome launched');
    await this.sessions.main.getPage(); // warm up: navigate & solve Cloudflare challenge at startup
  }

  async onModuleDestroy() {
    await this.browser?.close();
  }

  private async interceptApiResponse(
    urlPattern: RegExp,
    triggerUrl: string,
  ): Promise<unknown> {
    const main = this.sessions.main;
    const mainPage = await main.getPage();

    const responsePromise = mainPage.waitForResponse(
      (res) => urlPattern.test(res.url()) && [200, 401].includes(res.status()),
      { timeout: 60000 },
    );
    await mainPage.goto(triggerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await main.waitForCfChallenge(mainPage);
    const response = await responsePromise;
    if (response.status() === 401) {
      throw new UnauthorizedException(`Traderie session missing or expired — run scripts/login.ts and copy ${AUTH_STATE}`);
    }
    const data = (await response.json()) as unknown;
    this.log.log(`Intercepted ${response.url()} → ${response.status()}`);
    await main.saveAuth();
    return data;
  }

  private listingsPath(search: string, page: number, extra: string) {
    return `/api/diablo2resurrected/listings?itemTags=true&selling=true&auction=false&page=${page}&priceValues=true&search=${encodeURIComponent(search)}${extra}`;
  }

  private buildFilters(opts: ListingFilters): string {
    // Traderie only honors prop_* filters; bare mode/ladder/ethereal are silently ignored
    const parts = ['prop_Platform=PC'];
    if (opts.mode) parts.push(`prop_Mode=${opts.mode === 'hc' ? 'hardcore' : 'softcore'}`);
    if (opts.ladder !== undefined) parts.push(`prop_Ladder=${opts.ladder}`);
    if (opts.ethereal) parts.push('prop_Ethereal=true');
    return `&${parts.join('&')}`;
  }

  async fetchProducts(search: string) {
    const pattern = /\/api\/diablo2resurrected\/tags\/items/;
    const triggerUrl = `https://traderie.com/diablo2resurrected?search=${encodeURIComponent(search)}`;
    return this.interceptApiResponse(pattern, triggerUrl);
  }

  async fetchListings(search: string, page = 0, filters: ListingFilters = {}, session: SessionName = 'main') {
    return this.sessions[session].fetchApi(this.listingsPath(search, page, this.buildFilters(filters)));
  }

  async fetchCompletedListings(search: string, page = 0, filters: ListingFilters = {}) {
    return this.sessions.main.fetchApi(this.listingsPath(search, page, `&completed=true${this.buildFilters(filters)}`));
  }
}
