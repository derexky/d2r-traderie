import {
  BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, ParseIntPipe, Post, Query,
} from '@nestjs/common';
import { TradesService } from './trades.service';

@Controller('trades')
export class TradesController {
  constructor(private readonly svc: TradesService) {}

  @Get()
  findAll(
    @Query('category') category?: string,
    @Query('item_ref') item_ref?: string,
    @Query('base_ref') base_ref?: string,
  ) {
    return this.svc.findAll({ category, item_ref, base_ref });
  }

  // owner_uid comes from d2r-service, which verified the user's Firebase ID token
  @Post()
  create(@Body() body?: Record<string, unknown>) {
    const str = (k: string) => (typeof body?.[k] === 'string' ? (body[k] as string).trim() : '');
    const [item_name, price, contact, owner_uid] = [str('item_name'), str('price'), str('contact'), str('owner_uid')];
    if (!item_name || !price || !contact || !owner_uid) {
      throw new BadRequestException('item_name, price, contact, and owner_uid are required');
    }
    return this.svc.create({
      item_name,
      price,
      contact,
      owner_uid,
      item_stats_raw: str('item_stats_raw') || null,
      category: str('category') || null,
      item_ref: str('item_ref') || null,
      quality: str('quality') || null,
      base_ref: str('base_ref') || null,
    });
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Query('owner_uid') owner_uid?: string) {
    if (!owner_uid || !this.svc.remove(id, owner_uid)) throw new NotFoundException(`trade ${id} not found`);
    return { id };
  }
}
