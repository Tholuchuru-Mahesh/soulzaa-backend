import { ConfigService } from '@nestjs/config';
import { GooglePlayApiClient } from './google-play-api.client';

const SERVICE_ACCOUNT = JSON.stringify({
  client_email: 'play@example.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

const configWith = (payments: Record<string, unknown>) =>
  ({ get: () => payments }) as unknown as ConfigService;

describe('GooglePlayApiClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reports itself unconfigured when the service account is missing', () => {
    const client = new GooglePlayApiClient(
      configWith({ googlePlayPackageName: 'com.soulzaa.app' }),
    );

    expect(client.isConfigured()).toBe(false);
  });

  it('reports itself unconfigured when the package name is missing', () => {
    const client = new GooglePlayApiClient(
      configWith({ googlePlayServiceAccountJson: SERVICE_ACCOUNT }),
    );

    expect(client.isConfigured()).toBe(false);
  });

  it('requests the product purchase at the documented URL', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: SERVICE_ACCOUNT,
      }),
    );
    const request = jest.fn().mockResolvedValue({
      data: { orderId: 'GPA.1', productId: 'in_gold_100', purchaseState: 0 },
    });
    jest.spyOn(client as any, 'authClient').mockReturnValue({ request });

    const result = await client.getProductPurchase('in_gold_100', 'tok-1');

    expect(request).toHaveBeenCalledWith({
      url:
        'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        'com.soulzaa.app/purchases/products/in_gold_100/tokens/tok-1',
      method: 'GET',
    });
    expect(result.orderId).toBe('GPA.1');
  });

  it('posts to the :consume endpoint when consuming', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: SERVICE_ACCOUNT,
      }),
    );
    const request = jest.fn().mockResolvedValue({ data: {} });
    jest.spyOn(client as any, 'authClient').mockReturnValue({ request });

    await client.consumeProductPurchase('in_gold_100', 'tok-1');

    expect(request).toHaveBeenCalledWith({
      url:
        'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/' +
        'com.soulzaa.app/purchases/products/in_gold_100/tokens/tok-1:consume',
      method: 'POST',
    });
  });

  it('throws when asked to call the API unconfigured', async () => {
    const client = new GooglePlayApiClient(configWith({}));

    await expect(client.getProductPurchase('in_gold_100', 'tok-1')).rejects.toThrow(
      /not configured/i,
    );
  });

  it('percent-encodes a hostile purchase token instead of splicing it into the path', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: SERVICE_ACCOUNT,
      }),
    );
    const request = jest.fn().mockResolvedValue({ data: {} });
    jest.spyOn(client as any, 'authClient').mockReturnValue({ request });

    const hostileToken = 'tok/../../other:consume';
    await client.getProductPurchase('in_gold_100', hostileToken);

    const requestedUrl = request.mock.calls[0][0].url as string;
    expect(requestedUrl).toContain(encodeURIComponent(hostileToken));
    expect(requestedUrl).not.toContain('tok/../../other:consume');
  });

  it('rejects with the JSON problem when the service-account credentials are not valid JSON', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: 'not-json{',
      }),
    );

    await expect(client.getProductPurchase('in_gold_100', 'tok-1')).rejects.toThrow(
      /not valid JSON/i,
    );
  });

  it('rejects naming the missing field when the service-account JSON has no private_key', async () => {
    const client = new GooglePlayApiClient(
      configWith({
        googlePlayPackageName: 'com.soulzaa.app',
        googlePlayServiceAccountJson: JSON.stringify({
          client_email: 'play@example.iam.gserviceaccount.com',
        }),
      }),
    );

    await expect(client.getProductPurchase('in_gold_100', 'tok-1')).rejects.toThrow(
      /missing client_email or private_key/i,
    );
  });
});
