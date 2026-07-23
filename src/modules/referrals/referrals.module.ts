import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from '../../infra/prisma/prisma.module';
import { ReferralController } from './controllers/referral.controller';
import { ReferralService } from './services/referral.service';
import { ReferralCodeService } from './services/referral-code.service';
import { ReferralCampaignService } from './services/referral-campaign.service';
import { ReferralQualificationService } from './services/referral-qualification.service';
import { ReferralRewardService } from './services/referral-reward.service';
import { ReferralFraudService } from './services/referral-fraud.service';
import { ReferralValidationService } from './services/referral-validation.service';
import { ReferralConfigurationService } from './services/referral-configuration.service';
import { ReferralStatisticsService } from './services/referral-statistics.service';
import { ReferralAuditService } from './services/referral-audit.service';
import { ReferralEventService } from './services/referral-event.service';
import { ReferralQueryService } from './services/referral-query.service';

const SERVICES = [
  ReferralService,
  ReferralCodeService,
  ReferralCampaignService,
  ReferralQualificationService,
  ReferralRewardService,
  ReferralFraudService,
  ReferralValidationService,
  ReferralConfigurationService,
  ReferralStatisticsService,
  ReferralAuditService,
  ReferralEventService,
  ReferralQueryService,
];

@Global()
@Module({
  imports: [PrismaModule],
  controllers: [ReferralController],
  providers: [...SERVICES],
  exports: [...SERVICES],
})
export class ReferralsModule {}
