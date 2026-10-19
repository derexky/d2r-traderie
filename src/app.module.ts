import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TraderieModule } from './traderie/traderie.module.js';
import { PricesModule } from './prices/prices.module.js';
import { TradesModule } from './trades/trades.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), TraderieModule, PricesModule, TradesModule],
})
export class AppModule {}
