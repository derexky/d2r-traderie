import { BadGatewayException, BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { AlertsService, NewAlert } from './alerts.service';
import { PropRule } from './match';

// Under prices/ so d2r-service's admin proxy reaches it like the tracked list
@Controller('prices')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get('alerts')
  list() {
    return this.svc.list();
  }

  // Body { item, max_value, ladder?: true, mode?: 'sc', props?: { "<traderie prop name>": min number | exact bool/string } }
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

  // Body { value }; adds the item when it isn't in the table yet
  @Put('values/:name')
  setValue(@Param('name') name: string, @Body() body?: Record<string, unknown>) {
    const value = body?.value;
    if (!name.trim()) throw new BadRequestException('name is required');
    if (typeof value !== 'number' || !(value > 0)) throw new BadRequestException('value must be a positive number');
    this.svc.setValue(name.trim(), value);
    return { name: name.trim(), value };
  }

  @Delete('values/:name')
  removeValue(@Param('name') name: string) {
    if (!this.svc.removeValue(name)) throw new NotFoundException(`no value for ${name}`);
    return { name };
  }

  private async parse(body?: Record<string, unknown>): Promise<NewAlert> {
    const search = typeof body?.item === 'string' ? body.item.trim() : '';
    const max_value = body?.max_value;
    const props = body?.props ?? {};
    if (!search) throw new BadRequestException('item is required');
    if (typeof max_value !== 'number' || !(max_value > 0)) throw new BadRequestException('max_value must be a positive number');
    if (typeof props !== 'object' || Array.isArray(props) || props === null ||
        !Object.values(props).every((v) => ['number', 'boolean', 'string'].includes(typeof v))) {
      throw new BadRequestException('props must map property names to a number, boolean or string');
    }
    const item = await this.svc.resolveName(search).catch((err: Error) => {
      throw new BadGatewayException(`traderie lookup failed: ${err.message}`);
    });
    if (!item) throw new BadRequestException(`no active traderie listings named "${search}"; check the English item name`);
    return {
      item,
      ladder: body?.ladder !== false,
      mode: body?.mode === 'hc' ? 'hc' : 'sc',
      max_value,
      props: props as Record<string, PropRule>,
    };
  }
}
