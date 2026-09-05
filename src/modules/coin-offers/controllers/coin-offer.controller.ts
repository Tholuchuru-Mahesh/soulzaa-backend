import { Controller, Get, UseGuards } from '@nestjs/common';
import { CoinOfferService } from '../services/coin-offer.service';
import { CurrentUser } from 'src/modules/authorization/decorators/authorization.decorators';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';

@Controller('coin-offers')
@UseGuards(JwtAuthGuard) // Requires user to be logged in to get their active offer
export class CoinOfferController {
  constructor(private readonly service: CoinOfferService) {}

  @Get('active')
  async active(@CurrentUser('id') userId: string) {
    return this.service.resolveEligibleOffer(userId);
  }
}
