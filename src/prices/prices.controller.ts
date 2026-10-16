import {
  BadGatewayException, BadRequestException, Body, ConflictException, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { PricesService, Mode } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly svc: PricesService) {}

  // Manual trigger. Body { items: [...] } syncs only those tracked items (every combo), else everything
  @Post('sync')
  async triggerSync(@Body() body?: { items?: unknown }) {
    if (body?.items === undefined) {
      await this.svc.triggerSync();
      return { message: 'sync started' };
    }
    const items = body.items;
    if (!Array.isArray(items) || items.length === 0 || !items.every((i) => typeof i === 'string')) {
      throw new BadRequestException('items must be a non-empty array of item names');
    }
    const unknown = items.filter((i) => !this.svc.isTracked(i));
    if (unknown.length) throw new BadRequestException(`not tracked: ${unknown.join(', ')}`);
    if (this.svc.isSyncing) throw new ConflictException('a sync is already running');
    this.svc.syncItems(items);
    return { message: 'sync started', items };
  }

  @Get('tracked')
  listTracked() {
    return this.svc.listTracked();
  }

  // Body { name, zh, category }; name is checked against traderie's completed trades and stored with
  // traderie's casing. Synced right away (every combo) unless a sync is running, in which case the next
  // scheduled run picks it up
  @Post('tracked')
  async addTracked(@Body() body?: Record<string, unknown>) {
    const [search, zh, category] = requireFields(body, ['name', 'zh', 'category']);
    const name = await this.svc.resolveName(search).catch((err: Error) => {
      throw new BadGatewayException(`traderie lookup failed: ${err.message}`);
    });
    if (!name) throw new BadRequestException(`no traderie trades named "${search}"; check the English item name`);
    if (this.svc.isTracked(name)) throw new ConflictException(`already tracked: ${name}`);
    this.svc.addTracked({ name, zh, category });
    const synced = !this.svc.isSyncing;
    if (synced) this.svc.syncItems([name]);
    return { name, zh, category, synced };
  }

  // Body { zh, category }
  @Patch('tracked/:name')
  updateTracked(@Param('name') name: string, @Body() body?: Record<string, unknown>) {
    const [zh, category] = requireFields(body, ['zh', 'category']);
    if (!this.svc.updateTracked(name, zh, category)) throw new NotFoundException(`not tracked: ${name}`);
    return { name, zh, category };
  }

  // Stops syncing and showing the item; its price history is kept
  @Delete('tracked/:name')
  removeTracked(@Param('name') name: string) {
    if (!this.svc.removeTracked(name)) throw new NotFoundException(`not tracked: ${name}`);
    return { name };
  }

  @Get('items')
  getTrackedItems() {
    return this.svc.getTrackedItems();
  }

  @Get('groups')
  getTrackedGroups() {
    return this.svc.getTrackedGroups();
  }

  @Get('latest')
  getLatest(@Query('item') item: string, @Query('ladder') ladder: string, @Query('mode') mode: string) {
    if (!item?.trim()) throw new BadRequestException('item is required');
    return this.svc.getHistory(item.trim(), ladder === 'true', validateMode(mode), 1)[0] ?? null;
  }

  @Get('history')
  getHistory(
    @Query('item') item: string,
    @Query('ladder') ladder: string,
    @Query('mode') mode: string,
    @Query('limit') limit?: string,
  ) {
    if (!item?.trim()) throw new BadRequestException('item is required');
    const n = parseInt(limit ?? '', 10);
    return this.svc.getHistory(item.trim(), ladder === 'true', validateMode(mode), n > 0 ? Math.min(n, 168) : 24);
  }
}

function requireFields(body: Record<string, unknown> | undefined, keys: string[]): string[] {
  const values = keys.map((k) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : ''));
  if (values.some((v) => !v)) throw new BadRequestException(`${keys.join(', ')} are required`);
  return values;
}

function validateMode(mode: string): Mode {
  return mode === 'hc' ? 'hc' : 'sc';
}
