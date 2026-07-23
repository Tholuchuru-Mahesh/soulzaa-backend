import { Injectable } from '@nestjs/common';
import {
  AssignWorkforceDto,
  ReassignWorkforceScopeDto,
  TransferWorkforceDto,
} from '../dto/workforce-assignment.dto';
import { WorkforceSearchFilterDto } from '../dto/workforce-query.dto';
import { UpdateWorkforceStatusDto } from '../dto/workforce-status.dto';
import { OperationalStatusService } from './operational-status.service';
import { ReportingHierarchyService } from './reporting-hierarchy.service';
import { WorkforceAssignmentService } from './workforce-assignment.service';
import { WorkforceQueryService } from './workforce-query.service';
import { WorkloadService } from './workload.service';

@Injectable()
export class WorkforceManagementService {
  constructor(
    private readonly queryService: WorkforceQueryService,
    private readonly assignmentService: WorkforceAssignmentService,
    private readonly hierarchyService: ReportingHierarchyService,
    private readonly workloadService: WorkloadService,
    private readonly statusService: OperationalStatusService,
  ) {}

  // Personnel Query & Search
  async searchWorkforce(dto: WorkforceSearchFilterDto) {
    return this.queryService.searchWorkforce(dto);
  }

  async getWorkforcePersonnelById(userId: string) {
    return this.queryService.getWorkforcePersonnelById(userId);
  }

  // Assignments & Transfers
  async assignWorkforce(dto: AssignWorkforceDto, actorId: string) {
    return this.assignmentService.assignWorkforce(dto, actorId);
  }

  async transferWorkforce(dto: TransferWorkforceDto, actorId: string) {
    return this.assignmentService.transferWorkforce(dto, actorId);
  }

  async reassignScope(dto: ReassignWorkforceScopeDto, actorId: string) {
    return this.assignmentService.reassignScope(dto, actorId);
  }

  // Reporting Hierarchy
  async getReportingHierarchy() {
    return this.hierarchyService.getReportingHierarchy();
  }

  // Workload Summary
  async getPersonnelWorkload(userId: string) {
    return this.workloadService.getPersonnelWorkload(userId);
  }

  // Operational Status
  async getOperationalStatus(userId: string) {
    return this.statusService.getOperationalStatus(userId);
  }

  async updateOperationalStatus(userId: string, dto: UpdateWorkforceStatusDto, actorId: string) {
    return this.statusService.updateOperationalStatus(userId, dto, actorId);
  }
}
