import { Controller, Get } from '@nestjs/common';
import { BannerService } from '../services/banner.service';

@Controller('banners')
export class BannerController {
  constructor(private readonly service: BannerService) {}

  @Get('active')
  active() {
    return this.service.listActiveForApp();
  }
}
