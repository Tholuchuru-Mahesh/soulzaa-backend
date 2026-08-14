import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from 'src/common/decorators/public.decorator';
import { CoinSellerCheckoutService } from '../services/coin-seller-checkout.service';

/**
 * Razorpay's callback for agency inventory purchases.
 *
 * Public by necessity — Razorpay has no bearer token to present — so the
 * signature is the only thing standing between this endpoint and an anonymous
 * request that credits inventory. It is verified against the raw bytes before
 * anything is read out of the payload.
 */
@ApiTags('Coin Seller Inventory')
@Controller('coin-seller/webhooks')
export class CoinSellerWebhookController {
  private readonly logger = new Logger(CoinSellerWebhookController.name);

  constructor(private readonly checkout: CoinSellerCheckoutService) {}

  @Public()
  @ApiExcludeEndpoint()
  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  async handleRazorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    const rawBody = req.rawBody;
    if (!rawBody) {
      // Without the exact bytes there is nothing trustworthy to verify, so this
      // is refused rather than verified against a reconstruction.
      this.logger.error('Razorpay webhook rejected: raw body unavailable');
      return { received: true, handled: false };
    }

    // Anything the service throws escapes as a non-2xx on purpose: Razorpay
    // retries those, which is what we want for a transient database failure.
    // Only events we understand and decline resolve to `{handled:false}`.
    const result = await this.checkout.handleWebhookEvent(rawBody, signature);
    return { received: true, ...result };
  }
}
