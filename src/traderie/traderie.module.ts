import { Module } from '@nestjs/common';
import { TraderieController } from './traderie.controller';
import { TraderieService } from './traderie.service';

@Module({
  controllers: [TraderieController],
  providers: [TraderieService],
  exports: [TraderieService],
})
export class TraderieModule {}
