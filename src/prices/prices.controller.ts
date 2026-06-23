import { Controller, Post } from '@nestjs/common';
import { PricesService } from './prices.service';

@Controller('prices')
export class PricesController {
  constructor(private readonly svc: PricesService) {}

  // Manual trigger for testing
  @Post('sync')
  async triggerSync() {
    await this.svc.triggerSync();
    return { message: 'sync started' };
  }
}
