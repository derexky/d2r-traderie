import { BadRequestException, Controller, Get, Post, Query } from '@nestjs/common';
import { PricesService, Mode } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly svc: PricesService) {}

  // Manual trigger for testing
  @Post('sync')
  async triggerSync() {
    await this.svc.triggerSync();
    return { message: 'sync started' };
  }

  @Get('items')
  getTrackedItems() {
    return this.svc.getTrackedItems();
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
