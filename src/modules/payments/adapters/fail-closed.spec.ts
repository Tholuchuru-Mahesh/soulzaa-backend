import { ConfigService } from '@nestjs/config';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { AppleIapAdapter } from './apple-iap.adapter';
import { GooglePlayAdapter } from './google-play.adapter';
import { MockGatewayAdapter } from './mock-gateway.adapter';

const configWith = (payments: Record<string, unknown>) =>
  ({ get: () => payments }) as unknown as ConfigService;

const order = { orderNumber: 'ord-1', priceAmount: 100, currency: 'USD' };

/**
 * The single most important property of a payment adapter: it must never report a
 * purchase as verified unless it actually verified something. A provider that is
 * unconfigured, unreachable, or handed a bad signature has to reject — anything
 * else is a free path to crediting a wallet.
 */
describe('payment adapters fail closed', () => {
  describe('GooglePlayAdapter', () => {
    // A throwaway RSA key stands in for the Play Console licence key.
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const licenseKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const purchase = JSON.stringify({ orderId: 'GPA.1234', productId: 'coins_500' });
    const sign = (payload: string) =>
      createSign('RSA-SHA1').update(payload, 'utf8').sign(privateKey, 'base64');

    it('verifies a genuinely signed purchase', async () => {
      const adapter = new GooglePlayAdapter(configWith({ googlePlayLicenseKey: licenseKey }));

      const result = await adapter.verifyReceipt(purchase, sign(purchase), order);

      expect(result.isVerified).toBe(true);
      expect(result.providerTxnId).toBe('GPA.1234');
    });

    it('rejects a purchase payload that was altered after signing', async () => {
      const adapter = new GooglePlayAdapter(configWith({ googlePlayLicenseKey: licenseKey }));
      const signature = sign(purchase);

      const tampered = JSON.stringify({ orderId: 'GPA.9999', productId: 'coins_50000' });
      const result = await adapter.verifyReceipt(tampered, signature, order);

      expect(result.isVerified).toBe(false);
    });

    it('rejects when unconfigured', async () => {
      const adapter = new GooglePlayAdapter(configWith({}));

      const result = await adapter.verifyReceipt(purchase, sign(purchase), order);

      expect(result.isVerified).toBe(false);
      expect(result.errorMessage).toMatch(/not configured/i);
    });

    it('rejects when no signature is supplied', async () => {
      const adapter = new GooglePlayAdapter(configWith({ googlePlayLicenseKey: licenseKey }));

      const result = await adapter.verifyReceipt(purchase, undefined, order);

      expect(result.isVerified).toBe(false);
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
