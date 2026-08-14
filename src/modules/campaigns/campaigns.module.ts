import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/infra/prisma/prisma.module';
import { MobileWorkforceModule } from 'src/modules/mobile-workforce/mobile-workforce.module';
import { CampaignController } from './controllers/campaign.controller';
import { CommunityProgramController } from './controllers/community-program.controller';
import { CampaignService } from './services/campaign.service';
import { CommunityProgramService } from './services/community-program.service';

/**
 * Campaigns — Official Portal module for territory-scoped promotional
 * campaigns and community programs.
 *
 * Both surfaces are read/write for Officials in their geographic scope.
 * No financial transactions or game-event side effects — purely
 * organizational/informational management objects.
 */
@Module({
  imports: [PrismaModule, MobileWorkforceModule],
  controllers: [CampaignController, CommunityProgramController],
  providers: [CampaignService, CommunityProgramService],
  exports: [CampaignService, CommunityProgramService],
})
export class CampaignsModule {}
