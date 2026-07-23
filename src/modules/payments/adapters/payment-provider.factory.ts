import { BadRequestException, Injectable } from '@nestjs/common';
import { PaymentProvider } from '@prisma/client';
import { AppleIapAdapter } from './apple-iap.adapter';
import { GooglePlayAdapter } from './google-play.adapter';
import { MockGatewayAdapter } from './mock-gateway.adapter';
import { IPaymentProviderAdapter } from './payment-provider.interface';
import { RazorpayAdapter } from './razorpay.adapter';
import { StripeAdapter } from './stripe.adapter';

@Injectable()
export class PaymentProviderFactory {
  constructor(
    private readonly googlePlayAdapter: GooglePlayAdapter,
    private readonly appleIapAdapter: AppleIapAdapter,
    private readonly razorpayAdapter: RazorpayAdapter,
    private readonly stripeAdapter: StripeAdapter,
    private readonly mockGatewayAdapter: MockGatewayAdapter,
  ) {}

  /**
   * Resolves the appropriate PaymentProviderAdapter strategy instance
   */
  getAdapter(provider: PaymentProvider): IPaymentProviderAdapter {
    switch (provider) {
      case PaymentProvider.GOOGLE_PLAY:
        return this.googlePlayAdapter;
      case PaymentProvider.APPLE_IAP:
        return this.appleIapAdapter;
      case PaymentProvider.RAZORPAY:
        return this.razorpayAdapter;
      case PaymentProvider.STRIPE:
        return this.stripeAdapter;
      case PaymentProvider.MOCK_GATEWAY:
        return this.mockGatewayAdapter;
      default:
        throw new BadRequestException(`Unsupported payment provider '${provider}'`);
    }
  }
}
