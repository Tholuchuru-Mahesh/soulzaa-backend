export interface CursorPaginationParams {
  take?: number;
  cursorId?: string;
}

export function buildCursorQuery(params: CursorPaginationParams) {
  const take = Math.min(params.take ?? 20, 100);
  if (!params.cursorId) {
    return { take };
  }

  return {
    take,
    skip: 1,
    cursor: {
      id: params.cursorId,
    },
  };
}

export async function batchProcess<T, R>(
  items: T[],
  batchSize: number,
  fn: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchRes = await fn(batch);
    results.push(...batchRes);
  }
  return results;
}
