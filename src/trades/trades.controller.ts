import { BadRequestException, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly svc: TradesService) {}

  @Get()
  findAll(@Query('category') category?: string) {
    return this.svc.findAll(category);
  }

  @Post()
  create(@Body() body?: Record<string, unknown>) {
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const [item_name, price, contact] = [str('item_name'), str('price'), str('contact')];
    if (!item_name || !price || !contact) throw new BadRequestException('item_name, price, and contact are required');
    return this.svc.create({
      item_name,
      price,
      contact,
      item_stats_raw: str('item_stats_raw') || null,
      category: str('category') || null,
    });
  }
}
