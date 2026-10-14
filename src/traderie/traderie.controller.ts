import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { TraderieService, ListingFilters } from './traderie.service';

@Controller('traderie')
export class TraderieController {
  constructor(private readonly svc: TraderieService) {}

  @Get('products')
  async getProducts(@Query('search') search: string) {
    if (!search?.trim()) throw new BadRequestException('search is required');
    return this.svc.fetchProducts(search.trim());
  }

  @Get('listings')
  async getListings(
    @Query('search') search: string,
    @Query('page') page?: string,
    @Query('mode') mode?: string,
    @Query('ladder') ladder?: string,
    @Query('ethereal') ethereal?: string,
  ) {
    if (!search?.trim()) throw new BadRequestException('search is required');
    const filters: ListingFilters = {
      ...(mode === 'hc' || mode === 'sc' ? { mode } : {}),
      ...(ladder !== undefined ? { ladder: ladder === 'true' } : {}),
      ...(ethereal === 'true' ? { ethereal: true } : {}),
    };
    return this.svc.fetchListings(search.trim(), page ? parseInt(page, 10) : 0, filters);
  }

  @Get('completed')
  async getCompleted(
    @Query('search') search: string,
    @Query('page') page?: string,
    @Query('mode') mode?: string,
    @Query('ladder') ladder?: string,
    @Query('ethereal') ethereal?: string,
  ) {
    if (!search?.trim()) throw new BadRequestException('search is required');
    const filters: ListingFilters = {
      ...(mode === 'hc' || mode === 'sc' ? { mode } : {}),
      ...(ladder !== undefined ? { ladder: ladder === 'true' } : {}),
      ...(ethereal === 'true' ? { ethereal: true } : {}),
    };
    return this.svc.fetchCompletedListings(
      search.trim(),
      page ? parseInt(page, 10) : 0,
      filters,
    );
  }
}
