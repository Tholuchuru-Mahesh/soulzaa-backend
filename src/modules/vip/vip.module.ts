import { Global, Module } from '@nestjs/common';
import { VipAdminController } from './controllers/vip-admin.controller';
import { VipController } from './controllers/vip.controller';
import { VIP_SERVICE } from './interfaces/vip.service.interface';
import { VipRechargeListener } from './listeners/vip-recharge.listener';
import { VipRepository } from './repositories/vip.repository';
import { VipAdminService } from './services/vip-admin.service';
import { VipConfigSeeder } from './services/vip-config.seeder.service';
import { VipService } from './services/vip.service';

/**
 * VIP (AR-7) — membership tiers (Bronze→Titan) driven by lifetime Gold-coin
 * recharge (consumed from the wallet's RECHARGE credits). Crossing a threshold
 * auto-upgrades and grants the tier's benefit cosmetics via the backpack.
 *
 * @Global so gifts (VIP-exclusive gate) and payments resolve VIP_SERVICE by
 * token without importing this module.
 */
@Global()
@Module({
  controllers: [VipController, VipAdminController],
  providers: [
    VipRepository,
    VipService,
    VipAdminService,
    VipConfigSeeder,
    VipRechargeListener,
    { provide: VIP_SERVICE, useExisting: VipService },
  ],
  exports: [VIP_SERVICE],
})
export class VipModule {}
