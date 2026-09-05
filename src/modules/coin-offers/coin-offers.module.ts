import { Module } from '@nestjs/common';
import { CoinOfferService } from './services/coin-offer.service';
import { CoinOfferRepository } from './repositories/coin-offer.repository';
import { CoinOfferAdminController } from './controllers/coin-offer-admin.controller';
import { CoinOfferController } from './controllers/coin-offer.controller';

@Module({
  controllers: [CoinOfferAdminController, CoinOfferController],
  providers: [CoinOfferService, CoinOfferRepository],
  exports: [CoinOfferService],
})
export class CoinOffersModule {}
