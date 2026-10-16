import { BadRequestException, Body, ConflictException, Controller, Get, Post, Query } from '@nestjs/common';
import { PricesService, Mode } from './prices.service';
import { TRACKED_ITEMS } from './tracked-items';

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
    const unknown = items.filter((i) => !TRACKED_ITEMS.includes(i));
    if (unknown.length) throw new BadRequestException(`not tracked: ${unknown.join(', ')}`);
    if (this.svc.isSyncing) throw new ConflictException('a sync is already running');
    this.svc.syncItems(items);
    return { message: 'sync started', items };
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

function validateMode(mode: string): Mode {
  return mode === 'hc' ? 'hc' : 'sc';
}
