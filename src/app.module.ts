import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TraderieModule } from './traderie/traderie.module.js';
import { PricesModule } from './prices/prices.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), TraderieModule, PricesModule],
})
export class AppModule {}
