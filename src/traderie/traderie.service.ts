import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { chromium, Browser, Page } from 'playwright';

const TRADERIE_HOME = 'https://traderie.com/diablo2resurrected';

export interface ListingFilters {
  mode?: 'hc' | 'sc';
  ladder?: boolean;
  ethereal?: boolean;
}

@Injectable()
export class TraderieService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TraderieService.name);
  private browser: Browser | null = null;
  private page: Page | null = null;

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
    await this.getPage(); // warm up: navigate & solve Cloudflare challenge at startup
  }

  async onModuleDestroy() {
    await this.browser?.close();
  }

  private async waitForCfChallenge(page: Page): Promise<void> {
    if ((await page.title()) === 'Just a moment...') {
      this.log.log('Waiting for Cloudflare challenge...');
      await page.waitForFunction(
        () => document.title !== 'Just a moment...',
        { timeout: 30000 },
      );
    }
  }

  private async getPage(): Promise<Page> {
    if (!this.page || this.page.isClosed()) {
      const context = await this.browser!.newContext();
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      this.page = await context.newPage();
      this.log.log('Navigating to traderie.com...');

      // Visit home first, then a search URL to establish cf_clearance for search paths
      await this.page.goto(TRADERIE_HOME, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitForCfChallenge(this.page);

      await this.page.goto(`${TRADERIE_HOME}?search=test`, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await this.waitForCfChallenge(this.page);

      const cookies = await this.page.context().cookies('https://traderie.com');
      const hasCf = cookies.some((c) => c.name === 'cf_clearance');
      this.log.log(`cf_clearance set: ${hasCf}`);

      this.log.log('Traderie page ready');
    }
    return this.page;
  }

  private async interceptApiResponse(
    urlPattern: RegExp,
    triggerUrl: string,
  ): Promise<unknown> {
    const mainPage = await this.getPage();

    const responsePromise = mainPage.waitForResponse(
      (res) => urlPattern.test(res.url()) && res.status() === 200,
      { timeout: 60000 },
    );
    await mainPage.goto(triggerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await this.waitForCfChallenge(mainPage);
    const response = await responsePromise;
    const data = (await response.json()) as unknown;
    this.log.log(`Intercepted ${response.url()} → ${response.status()}`);
    return data;
  }

  private buildFilters(opts: ListingFilters): string {
    const parts: string[] = [];
    if (opts.mode) parts.push(`mode=${opts.mode}`);
    if (opts.ladder !== undefined) parts.push(`ladder=${opts.ladder}`);
    if (opts.ethereal) parts.push(`ethereal=true`);
    return parts.length ? `&${parts.join('&')}` : '';
  }

  async fetchProducts(search: string) {
    const pattern = /\/api\/diablo2resurrected\/tags\/items/;
    const triggerUrl = `https://traderie.com/diablo2resurrected?search=${encodeURIComponent(search)}`;
    return this.interceptApiResponse(pattern, triggerUrl);
  }

  async fetchListings(search: string, page = 1, filters: ListingFilters = {}) {
    const encoded = encodeURIComponent(search);
    const pattern = /\/api\/diablo2resurrected\/listings\?.*search=/;
    const triggerUrl = `https://traderie.com/diablo2resurrected?search=${encoded}&page=${page}${this.buildFilters(filters)}`;
    return this.interceptApiResponse(pattern, triggerUrl);
  }

  async fetchCompletedListings(search: string, page = 1, filters: ListingFilters = {}) {
    const encoded = encodeURIComponent(search);
    const pattern =
      /\/api\/diablo2resurrected\/listings\?.*search=.*completed=true/;
    const triggerUrl = `https://traderie.com/diablo2resurrected?search=${encoded}&page=${page}&completed=true${this.buildFilters(filters)}`;
    return this.interceptApiResponse(pattern, triggerUrl);
  }
}
