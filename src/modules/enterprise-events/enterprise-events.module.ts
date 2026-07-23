import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { EnterpriseEventController } from './controllers/event.controller';
import { EventAuditService } from './services/event-audit.service';
import { EventConfigurationService } from './services/event-configuration.service';
import { EventEligibilityService } from './services/event-eligibility.service';
import { EventEventService } from './services/event-event.service';
import { EventParticipationService } from './services/event-participation.service';
import { EventQueryService } from './services/event-query.service';
import { EventRegistrationService } from './services/event-registration.service';
import { EventRewardService } from './services/event-reward.service';
import { EventSchedulerService } from './services/event-scheduler.service';
import { EventService } from './services/event.service';
import { EventStatisticsService } from './services/event-statistics.service';
import { EventValidationService } from './services/event-validation.service';

@Global()
@Module({
  imports: [PlatformConfigurationModule],
  controllers: [EnterpriseEventController],
  providers: [
    // Phase 16: Enterprise Events Engine Services
    EventConfigurationService,
    EventValidationService,
    EventAuditService,
    EventEventService,
    EventEligibilityService,
    EventRewardService,
    EventRegistrationService,
    EventParticipationService,
    EventSchedulerService,
    EventService,
    EventStatisticsService,
    EventQueryService,
  ],
  exports: [
    EventConfigurationService,
    EventValidationService,
    EventAuditService,
    EventEventService,
    EventEligibilityService,
    EventRewardService,
    EventRegistrationService,
    EventParticipationService,
    EventSchedulerService,
    EventService,
    EventStatisticsService,
    EventQueryService,
  ],
})
export class EnterpriseEventsModule {}
