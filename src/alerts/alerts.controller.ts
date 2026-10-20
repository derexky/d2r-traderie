import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { AlertsService, COMBOS, NewAlert } from './alerts.service';
import { Condition } from './match';

// Under prices/ so d2r-service's admin proxy reaches it like the tracked list
@Controller('prices')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get('alerts')
  list() {
    return this.svc.list();
  }

  // Declared before alerts/:id routes; ?item= English name, any casing. Lists every property the item can be
  // filtered by, with the id/name/options a condition needs
  @Get('alerts/props')
  async props(@Query('item') item?: string) {
    if (!item?.trim()) throw new BadRequestException('item is required');
    const res = await this.svc.propsOf(item.trim()).catch((err: Error) => {
      throw new BadGatewayException(`traderie lookup failed: ${err.message}`);
    });
    if (!res) throw new NotFoundException(`no traderie listings named "${item.trim()}"; check the English item name`);
    return res;
  }

  // Body { item, max_value, ladder?: true, mode?: 'sc', conditions?: Condition[] }; condition id/name/type come from
  // GET alerts/props, e.g. { id: 520, name: '+{{value}}% Faster Cast Rate', type: 'number', min: 35 }
  @Post('alerts')
  async add(@Body() body?: Record<string, unknown>) {
    return this.svc.add(await this.parse(body));
  }

  // Same body as POST, replaces the whole alert
  @Patch('alerts/:id')
  async update(@Param('id') id: string, @Body() body?: Record<string, unknown>) {
    const alert = this.svc.update(Number(id), await this.parse(body));
    if (!alert) throw new NotFoundException(`no alert #${id}`);
    return alert;
  }

  @Delete('alerts/:id')
  remove(@Param('id') id: string) {
    if (!this.svc.remove(Number(id))) throw new NotFoundException(`no alert #${id}`);
    return { id: Number(id) };
  }

  // Manual trigger for testing; runs in the background
  @Post('alerts/check')
  check() {
    void this.svc.check();
    return { message: 'check started' };
  }

  @Get('values')
  listValues() {
    return this.svc.listValues();
  }

  // Body { value }; adds the item when it isn't in that combo's table yet
  @Put('values/:combo/:name')
  setValue(@Param('combo') combo: string, @Param('name') name: string, @Body() body?: Record<string, unknown>) {
    const value = body?.value;
    if (!COMBOS.includes(combo)) throw new BadRequestException(`combo must be one of ${COMBOS.join(', ')}`);
    if (!name.trim()) throw new BadRequestException('name is required');
    if (typeof value !== 'number' || !(value > 0)) throw new BadRequestException('value must be a positive number');
    this.svc.setValue(combo, name.trim(), value);
    return { combo, name: name.trim(), value };
  }

  @Delete('values/:combo/:name')
  removeValue(@Param('combo') combo: string, @Param('name') name: string) {
    if (!this.svc.removeValue(combo, name)) throw new NotFoundException(`no ${combo} value for ${name}`);
    return { combo, name };
  }

  private async parse(body?: Record<string, unknown>): Promise<NewAlert> {
    const search = typeof body?.item === 'string' ? body.item.trim() : '';
    const max_value = body?.max_value;
    if (!search) throw new BadRequestException('item is required');
    if (typeof max_value !== 'number' || !(max_value > 0)) throw new BadRequestException('max_value must be a positive number');
    const conditions = parseConditions(body?.conditions ?? []);
    const item = await this.svc.resolveItem(search).catch((err: Error) => {
      throw new BadGatewayException(`traderie lookup failed: ${err.message}`);
    });
    if (!item) throw new BadRequestException(`no active traderie listings named "${search}"; check the English item name`);
    return {
      item: item.name,
      item_id: item.id,
      ladder: body?.ladder !== false,
      mode: body?.mode === 'hc' ? 'hc' : 'sc',
      max_value,
      conditions,
    };
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Keeps only the fields each condition type uses
function parseConditions(raw: unknown): Condition[] {
  if (!Array.isArray(raw)) throw new BadRequestException('conditions must be an array');
  return raw.map((c: any, i) => {
    const bad = (why: string) => new BadRequestException(`conditions[${i}]: ${why}`);
    if (!Number.isInteger(c?.id) || typeof c?.name !== 'string' || !c.name) throw bad('id and name are required');
    const { id, name } = c as { id: number; name: string };
    switch (c.type) {
      case 'number': {
        const min = c.min ?? undefined;
        const max = c.max ?? undefined;
        if ((min !== undefined && !isNum(min)) || (max !== undefined && !isNum(max))) throw bad('min and max must be numbers');
        if (min === undefined && max === undefined) throw bad('a number condition needs min or max');
        if (min !== undefined && max !== undefined && min > max) throw bad('min is above max');
        return { id, name, type: 'number', ...(min !== undefined && { min }), ...(max !== undefined && { max }) };
      }
      case 'string':
        if (!Array.isArray(c.values) || !c.values.length || !c.values.every((v: unknown) => typeof v === 'string' && v)) {
          throw bad('values must be a non-empty array of strings');
        }
        return { id, name, type: 'string', values: c.values };
      case 'bool':
        if (typeof c.value !== 'boolean') throw bad('value must be true or false');
        return { id, name, type: 'bool', value: c.value };
      default:
        throw bad('type must be number, string or bool');
    }
  });
}
