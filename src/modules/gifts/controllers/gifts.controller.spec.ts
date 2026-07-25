import { GiftsController } from './gifts.controller';

/**
 * Defect 1: `GiftController` and `GiftsController` both declared
 * `@Controller('gifts')` + `@Post('send')` with divergent economics. The
 * canonical send engine is `GiftService` (via `GiftController`); the duplicate
 * on `GiftsController` is removed so there is exactly one `POST /gifts/send`.
 */
describe('GiftsController', () => {
  it('does not expose a sendGift handler (single POST /gifts/send lives on GiftController)', () => {
    expect(
      (GiftsController.prototype as unknown as { sendGift?: unknown }).sendGift,
    ).toBeUndefined();
  });

  it('still exposes its unique read routes', () => {
    const proto = GiftsController.prototype as unknown as Record<string, unknown>;
    for (const method of [
      'listGifts',
      'listCategories',
      'searchGifts',
      'getPopularGifts',
      'getMyGiftHistory',
      'getMyInventory',
      'getGiftById',
    ]) {
      expect(typeof proto[method]).toBe('function');
    }
  });
});
