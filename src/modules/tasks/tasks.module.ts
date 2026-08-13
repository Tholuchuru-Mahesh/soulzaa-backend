import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { NotificationModule } from 'src/modules/notification/notification.module';
import { TaskController } from './controllers/task.controller';
import { MissionProgressService } from './services/mission-progress.service';
import { MissionService } from './services/mission.service';
import { TaskAuditService } from './services/task-audit.service';
import { TaskConfigurationService } from './services/task-configuration.service';
import { TaskEvaluationService } from './services/task-evaluation.service';
import { TaskEventService } from './services/task-event.service';
import { TaskProgressService } from './services/task-progress.service';
import { TaskQueryService } from './services/task-query.service';
import { TaskRewardService } from './services/task-reward.service';
import { TaskService } from './services/task.service';
import { TaskStatisticsService } from './services/task-statistics.service';
import { TaskValidationService } from './services/task-validation.service';
import { TaskProgressionListener } from './listeners/task-progression.listener';
import { ModeratorTaskAssignmentService } from './services/moderator-task-assignment.service';

@Global()
@Module({
  imports: [PlatformConfigurationModule, NotificationModule],
  controllers: [TaskController],
  providers: [
    // Phase 17: Enterprise Tasks & Missions Engine Services
    TaskProgressionListener,
    TaskConfigurationService,
    TaskValidationService,
    TaskAuditService,
    TaskEventService,
    TaskStatisticsService,
    TaskProgressService,
    MissionProgressService,
    TaskRewardService,
    TaskEvaluationService,
    TaskService,
    MissionService,
    TaskQueryService,
    ModeratorTaskAssignmentService,
  ],
  exports: [
    TaskConfigurationService,
    TaskValidationService,
    TaskAuditService,
    TaskEventService,
    TaskStatisticsService,
    TaskProgressService,
    MissionProgressService,
    TaskRewardService,
    TaskEvaluationService,
    TaskService,
    MissionService,
    TaskQueryService,
    ModeratorTaskAssignmentService,
  ],
})
export class TasksModule {}
