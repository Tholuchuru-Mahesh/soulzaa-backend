import { ConfigService } from '@nestjs/config';
import { AppleIapAdapter } from './apple-iap.adapter';
import { GooglePlayAdapter } from './google-play.adapter';
import { MockGatewayAdapter } from './mock-gateway.adapter';

const configWith = (payments: Record<string, unknown>) =>
  ({ get: () => payments }) as unknown as ConfigService;

const order = {
  orderNumber: 'ord-1',
  priceAmount: 100,
  currency: 'USD',
  // GooglePlayAdapter looks up the store product ID from the order's package;
  // Apple and Mock ignore this field.
  package: { googleProductId: 'in_gold_100' },
};

/**
 * The single most important property of a payment adapter: it must never report a
 * purchase as verified unless it actually verified something. A provider that is
 * unconfigured, unreachable, or handed a bad signature has to reject — anything
 * else is a free path to crediting a wallet.
 */
describe('payment adapters fail closed', () => {
  describe('GooglePlayAdapter', () => {
    const configuredClient = (purchase: Record<string, unknown>) =>
      ({
        isConfigured: () => true,
        getProductPurchase: jest.fn().mockResolvedValue(purchase),
      }) as any;

    it('surfaces the fields the verification service asserts on', async () => {
      const adapter = new GooglePlayAdapter(
        configuredClient({
          orderId: 'GPA.1234',
          productId: 'in_gold_100',
          purchaseState: 0,
          consumptionState: 0,
          obfuscatedExternalAccountId: 'user-1',
        }),
      );

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(true);
      expect(result.providerTxnId).toBe('GPA.1234');
      expect(result.productId).toBe('in_gold_100');
      expect(result.purchaseState).toBe(0);
      expect(result.consumptionState).toBe(0);
      expect(result.externalAccountId).toBe('user-1');
    });

    it('rejects when unconfigured', async () => {
      const adapter = new GooglePlayAdapter({
        isConfigured: () => false,
        getProductPurchase: jest.fn(),
      } as any);

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/not configured/i);
    });

    it('rejects when Google returns an error rather than falling through to success', async () => {
      const adapter = new GooglePlayAdapter({
        isConfigured: () => true,
        getProductPurchase: jest.fn().mockRejectedValue(new Error('HTTP 410 token expired')),
      } as any);

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/410/);
    });

    it('rejects a response with no orderId', async () => {
      const adapter = new GooglePlayAdapter(
        configuredClient({ productId: 'in_gold_100', purchaseState: 0 }),
      );

      const result = await adapter.verifyReceipt('purchase-token', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/orderId/i);
    });
  });

  describe('AppleIapAdapter', () => {
    afterEach(() => jest.restoreAllMocks());

    it('rejects when unconfigured', async () => {
      const adapter = new AppleIapAdapter(configWith({}));

      const result = await adapter.verifyReceipt('receipt', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/not configured/i);
    });

    it('accepts a receipt Apple confirms', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 0,
          latest_receipt_info: [{ transaction_id: '100001', product_id: 'coins_500' }],
        }),
      } as unknown as Response);
      const adapter = new AppleIapAdapter(configWith({ appleSharedSecret: 's3cret' }));

      const result = await adapter.verifyReceipt('receipt', undefined, order);

      expect(result.isVerified).toBe(true);
      expect(result.providerTxnId).toBe('100001');
    });

    it('rejects a receipt Apple refuses', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ status: 21003 }),
      } as unknown as Response);
      const adapter = new AppleIapAdapter(configWith({ appleSharedSecret: 's3cret' }));

      const result = await adapter.verifyReceipt('receipt', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toContain('21003');
    });

    it('rejects rather than approving when Apple is unreachable', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
      const adapter = new AppleIapAdapter(configWith({ appleSharedSecret: 's3cret' }));

      const result = await adapter.verifyReceipt('receipt', undefined, order);

      expect(result.isVerified).toBe(false);
    });

    it('retries against sandbox when Apple says the receipt is a sandbox one', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ status: 21007 }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            status: 0,
            latest_receipt_info: [{ transaction_id: 'sandbox-1' }],
          }),
        } as unknown as Response);

      const adapter = new AppleIapAdapter(configWith({ appleSharedSecret: 's3cret' }));
      const result = await adapter.verifyReceipt('receipt', undefined, order);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain('sandbox');
      expect(result.isVerified).toBe(true);
    });
  });

  describe('MockGatewayAdapter', () => {
    it('refuses to approve anything unless explicitly enabled', async () => {
      const adapter = new MockGatewayAdapter(configWith({}));

      const result = await adapter.verifyReceipt('anything', undefined, order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/disabled/i);
    });

    it('approves when explicitly enabled for a test environment', async () => {
      const adapter = new MockGatewayAdapter(configWith({ allowMockGateway: true }));

      const result = await adapter.verifyReceipt('anything', undefined, order);

      expect(result.isVerified).toBe(true);
    });
  });
});
