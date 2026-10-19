import { Module } from '@nestjs/common';
import { TraderieModule } from '../traderie/traderie.module';
import { AlertsController } from './alerts.controller';
import { AlertsService } from './alerts.service';

@Module({
  imports: [TraderieModule],
  controllers: [AlertsController],
  providers: [AlertsService],
})
export class AlertsModule {}
