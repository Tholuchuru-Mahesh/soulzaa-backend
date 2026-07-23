import { Global, Module } from '@nestjs/common';
import { PlatformConfigurationModule } from 'src/modules/platform-configuration/platform-configuration.module';
import { FamilyController } from './controllers/family.controller';
import { FamiliesController } from './controllers/families.controller';
import { FAMILIES_SERVICE } from './interfaces/families.service.interface';
import { FamiliesRepository } from './repositories/families.repository';
import { FamiliesService } from './services/families.service';
import {
  FamilyAuditService,
  FamilyConfigurationService,
  FamilyEventService,
  FamilyHistoryService,
  FamilyInvitationService,
  FamilyMemberService,
  FamilyPermissionService,
  FamilyQueryService,
  FamilyRequestService,
  FamilyRoleService,
  FamilyService,
  FamilyStatisticsService,
  FamilyValidationService,
} from './services';

@Global()
@Module({
  imports: [PlatformConfigurationModule],
  controllers: [FamilyController, FamiliesController],
  providers: [
    FamiliesRepository,
    FamiliesService,
    {
      provide: FAMILIES_SERVICE,
      useClass: FamiliesService,
    },
    FamilyConfigurationService,
    FamilyValidationService,
    FamilyPermissionService,
    FamilyRoleService,
    FamilyMemberService,
    FamilyInvitationService,
    FamilyRequestService,
    FamilyService,
    FamilyHistoryService,
    FamilyAuditService,
    FamilyStatisticsService,
    FamilyQueryService,
    FamilyEventService,
  ],
  exports: [
    FamiliesRepository,
    FamiliesService,
    FAMILIES_SERVICE,
    FamilyConfigurationService,
    FamilyValidationService,
    FamilyPermissionService,
    FamilyRoleService,
    FamilyMemberService,
    FamilyInvitationService,
    FamilyRequestService,
    FamilyService,
    FamilyHistoryService,
    FamilyAuditService,
    FamilyStatisticsService,
    FamilyQueryService,
    FamilyEventService,
  ],
})
export class FamiliesModule {}
