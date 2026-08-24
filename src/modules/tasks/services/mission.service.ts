import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { TaskAuditService } from './task-audit.service';
import { TaskValidationService } from './task-validation.service';

export interface CreateMissionInput {
  code: string;
  name: string;
  description?: string;
  category: string;
  requiredTaskCount?: number;
  rewardDefinition?: Record<string, any>;
  actorId?: string;
}

@Injectable()
export class MissionService {
  private readonly logger = new Logger(MissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly validationService: TaskValidationService,
    private readonly auditService: TaskAuditService,
  ) {}

  async createMission(input: CreateMissionInput) {
    this.validationService.validateCategory(input.category);

    const mission = await this.prisma.missionDefinition.create({
      data: {
        code: input.code,
        name: input.name,
        description: input.description,
        category: input.category,
        requiredTaskCount: input.requiredTaskCount ?? 1,
        rewardDefinition: input.rewardDefinition,
        status: 'ACTIVE',
      },
    });

    await this.auditService.logAudit('MISSION_CREATED', undefined, input.actorId, {
      missionId: mission.id,
      code: mission.code,
    });

    return mission;
  }

  async getMissions(category?: string, status?: string) {
    return this.prisma.missionDefinition.findMany({
      where: {
        ...(category && category !== 'ALL' ? { category } : {}),
        ...(status && status !== 'ALL' ? { status } : {}),
      },
      include: { tasks: true },
      orderBy: { name: 'asc' },
    });
  }

  async getMission(idOrCode: string) {
    const byId = await this.prisma.missionDefinition
      .findUnique({ where: { id: idOrCode }, include: { tasks: true } })
      .catch(() => null);

    return (
      byId ??
      this.prisma.missionDefinition.findUnique({
        where: { code: idOrCode },
        include: { tasks: true },
      })
    );
  }
}
