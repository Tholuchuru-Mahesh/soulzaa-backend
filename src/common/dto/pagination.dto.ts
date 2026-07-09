import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  MIN_LIMIT,
} from '../constants/pagination.constants';
import type { Paginated } from '../interfaces/api-response.interface';
import { buildPaginated } from '../utils/pagination.util';

/** Standard offset pagination query. Shared by list endpoints. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: MIN_LIMIT, default: DEFAULT_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = DEFAULT_PAGE;

  @ApiPropertyOptional({ minimum: MIN_LIMIT, maximum: MAX_LIMIT, default: DEFAULT_LIMIT })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(MIN_LIMIT)
  @Max(MAX_LIMIT)
  limit = DEFAULT_LIMIT;

  get skip(): number {
    return (this.page - 1) * this.limit;
  }
}

/** @deprecated use `Paginated<T>` from api-response.interface. */
export type PaginatedResult<T> = Paginated<T>;

/** Build a paginated payload (delegates to the canonical utils builder). */
export function paginate<T>(items: T[], total: number, page: number, limit: number): Paginated<T> {
  return buildPaginated(items, total, page, limit);
}
