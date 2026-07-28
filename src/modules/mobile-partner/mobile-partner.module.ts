import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobilePartnerController } from './controllers/mobile-partner.controller';
import { MobilePartnerService } from './services/mobile-partner.service';

/**
 * Mobile console for external partners — Agency, Coin Seller and Host.
 *
 * Read-only and ownership-scoped: every query is keyed on the authenticated
 * user's own id, so the boundary holds structurally rather than by check.
 */
@Module({
  imports: [PrismaModule],
  controllers: [MobilePartnerController],
  providers: [MobilePartnerService],
  exports: [MobilePartnerService],
})
export class MobilePartnerModule {}
