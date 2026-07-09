import {
  DEFAULT_LIMIT,
  DEFAULT_PAGE,
  MAX_LIMIT,
  MIN_LIMIT,
} from '../constants/pagination.constants';
import type { Paginated } from '../interfaces/api-response.interface';

/** Clamp page/limit to safe bounds, applying defaults for missing values. */
export function normalizePagination(input: { page?: number; limit?: number } = {}): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(DEFAULT_PAGE, Math.floor(input.page ?? DEFAULT_PAGE));
  const limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(input.limit ?? DEFAULT_LIMIT)));
  return { page, limit, skip: (page - 1) * limit };
}

/** Build the canonical paginated payload (goes inside SuccessResponse.data). */
export function buildPaginated<T>(
  items: T[],
  total: number,
  page: number,
  limit: number,
): Paginated<T> {
  return { items, total, page, limit, totalPages: Math.ceil(total / limit) || 1 };
}
