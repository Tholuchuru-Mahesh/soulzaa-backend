import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JWT } from 'google-auth-library';

const API_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/** Subset of the Android Publisher ProductPurchase resource this codebase reads. */
export interface ProductPurchase {
  orderId?: string;
  productId?: string;
  /** 0 = purchased, 1 = cancelled, 2 = pending. */
  purchaseState?: number;
  /** 0 = yet to be consumed, 1 = consumed. */
  consumptionState?: number;
  acknowledgementState?: number;
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
}

/**
 * The only place that talks to the Android Publisher API.
 *
 * Kept separate from the adapter so that "how do we reach Google" and "is this
 * purchase allowed to settle this order" stay independently testable, and so the
 * verification path and the consume path share one authenticated client.
 */
@Injectable()
export class GooglePlayApiClient {
  private readonly logger = new Logger(GooglePlayApiClient.name);
  private cachedClient?: JWT;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const payments = this.config.get('payments', { infer: true });
    return Boolean(payments?.googlePlayPackageName && payments?.googlePlayServiceAccountJson);
  }

  async getProductPurchase(productId: string, purchaseToken: string): Promise<ProductPurchase> {
    const response = await this.authClient().request<ProductPurchase>({
      url: `${this.baseUrl(productId, purchaseToken)}`,
      method: 'GET',
    });
    return response.data;
  }

  async consumeProductPurchase(productId: string, purchaseToken: string): Promise<void> {
    await this.authClient().request({
      url: `${this.baseUrl(productId, purchaseToken)}:consume`,
      method: 'POST',
    });
  }

  private baseUrl(productId: string, purchaseToken: string): string {
    const packageName = this.config.get('payments', { infer: true })?.googlePlayPackageName;
    // purchaseToken (and, less critically, productId) originate in the client's
    // request body and are therefore attacker-controlled. Encoding them keeps a
    // token containing `/`, `..`, `?`, `#` or `:` confined to a single path
    // segment, so it can't redirect this authenticated request to a different
    // Google endpoint (e.g. forging the `:consume` suffix) or otherwise change
    // which resource our credentials are used against. Do not remove this.
    return `${API_ROOT}/${packageName}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  }

  /**
   * Built lazily and cached: constructing the JWT parses the service-account key,
   * which must not happen at module load in environments that have no credentials.
   */
  private authClient(): JWT {
    if (this.cachedClient) return this.cachedClient;

    if (!this.isConfigured()) {
      throw new Error(
        'Google Play API is not configured (package name or service account missing)',
      );
    }

    const raw = this.config.get('payments', { infer: true })!
      .googlePlayServiceAccountJson as string;
    let credentials: { client_email?: string; private_key?: string };
    try {
      credentials = JSON.parse(raw);
    } catch {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON');
    }

    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
    }

    this.cachedClient = new JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [SCOPE],
    });
    this.logger.log('Google Play API client initialised');
    return this.cachedClient;
  }
}
