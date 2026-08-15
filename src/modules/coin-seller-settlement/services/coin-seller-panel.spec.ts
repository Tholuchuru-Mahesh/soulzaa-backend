import { NotFoundException } from '@nestjs/common';
import { CoinSellerPanelService } from './coin-seller-panel.service';

/**
 * The order-status route is what the mobile app polls after the buyer returns
 * from Razorpay's hosted page, so the two things it must never get wrong are
 * whose order it reads and when it claims the coins have landed.
 */
describe('CoinSellerPanelService.getPurchaseOrderStatus', () => {
  const SELLER = 'seller-1';
  const ORDER = 'order-1';

  function build(findFirst: jest.Mock) {
    const prisma = {
      coinSellerInventoryPurchaseOrder: { findFirst },
    };
    return new CoinSellerPanelService(prisma as never, {} as never);
  }

  it('scopes the lookup to the calling seller', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);
    const service = build(findFirst);

    await expect(service.getPurchaseOrderStatus(SELLER, ORDER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // sellerId is part of the where clause, not checked after the read: another
    // seller's order must not be fetched at all.
    expect(findFirst).toHaveBeenCalledWith({ where: { id: ORDER, sellerId: SELLER } });
  });

  it('reports credited only once the inventory has actually been credited', async () => {
    const creditedAt = new Date('2026-08-15T10:00:00Z');
    const service = build(
      jest.fn().mockResolvedValue({
        id: ORDER,
        status: 'INVENTORY_CREDITED',
        coinAmount: BigInt(110000),
        priceAmount: '40000.00',
        priceCurrency: 'INR',
        creditedAt,
      }),
    );

    const res = await service.getPurchaseOrderStatus(SELLER, ORDER);

    expect(res).toMatchObject({
      purchaseOrderId: ORDER,
      status: 'INVENTORY_CREDITED',
      credited: true,
      // BigInt is serialised as a string: 110000 coins would otherwise not
      // survive JSON at the larger tiers.
      coinAmount: '110000',
      priceAmount: 40000,
      creditedAt,
    });
  });

  it('does not report credited for a paid-but-uncredited order', async () => {
    // The gap this covers: Razorpay has taken the money and the buyer is back
    // in the app, but the webhook has not finished crediting. Treating that as
    // done would show a success screen over a balance that has not moved.
    const service = build(
      jest.fn().mockResolvedValue({
        id: ORDER,
        status: 'PAYMENT_VERIFIED',
        coinAmount: BigInt(275),
        priceAmount: '100.00',
        priceCurrency: 'INR',
        creditedAt: null,
      }),
    );

    const res = await service.getPurchaseOrderStatus(SELLER, ORDER);

    expect(res.credited).toBe(false);
    expect(res.status).toBe('PAYMENT_VERIFIED');
  });
});
