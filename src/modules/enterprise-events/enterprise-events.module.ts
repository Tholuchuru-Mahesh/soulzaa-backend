import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { QueueModule } from 'src/infra/queue/queue.module';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { ENTERPRISE_EVENT_QUEUES } from './constants/event-jobs.constants';
import { EnterpriseEventController } from './controllers/event.controller';
import { EventDraftController } from './controllers/event-draft.controller';
import { EnterpriseEventProcessor } from './processors/event.processor';
import { EventLifecycleScheduler } from './services/event.scheduler';
import { EventAuditService } from './services/event-audit.service';
import { EventConfigurationService } from './services/event-configuration.service';
import { EventDraftService } from './services/event-draft.service';
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
import { EventProgressionListener } from './listeners/event-progression.listener';

@Global()
@Module({
  imports: [
    PlatformConfigurationModule,
    QueueModule,
    BullModule.registerQueue({ name: ENTERPRISE_EVENT_QUEUES.LIFECYCLE }),
  ],
  controllers: [EnterpriseEventController, EventDraftController],
  providers: [
    // Phase 16: Enterprise Events Engine Services
    EventProgressionListener,
    EventLifecycleScheduler,
    EnterpriseEventProcessor,
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
    EventDraftService,
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
    EventDraftService,
  ],
})
export class EnterpriseEventsModule {}
