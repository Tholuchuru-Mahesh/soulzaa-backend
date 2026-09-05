import { Module } from '@nestjs/common';
import { BannerRepository } from './repositories/banner.repository';
import { BannerService } from './services/banner.service';
import { BannerAdminController } from './controllers/banner-admin.controller';
import { BannerController } from './controllers/banner.controller';

@Module({
  controllers: [BannerAdminController, BannerController],
  providers: [BannerRepository, BannerService],
  exports: [BannerService],
})
export class BannersModule {}
