import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

@Injectable()
export class AgencyRelationshipService {
  private readonly logger = new Logger(AgencyRelationshipService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieves active agency mapping for a host. Returns null if host is independent (unassigned).
   */
  async getActiveAgencyForHost(hostId: string) {
    return this.prisma.agencyRelationship.findFirst({
      where: {
        hostId,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Assigns a host to an agency or updates an existing relationship.
   */
  async assignHostToAgency(agencyId: string, hostId: string) {
    return this.prisma.agencyRelationship.upsert({
      where: {
        agencyId_hostId: { agencyId, hostId },
      },
      update: {
        status: 'ACTIVE',
        effectiveFrom: new Date(),
        effectiveUntil: null,
      },
      create: {
        agencyId,
        hostId,
        status: 'ACTIVE',
      },
    });
  }

  /**
   * Terminates an agency-host relationship.
   */
  async terminateRelationship(agencyId: string, hostId: string) {
    return this.prisma.agencyRelationship.updateMany({
      where: { agencyId, hostId, status: 'ACTIVE' },
      data: {
        status: 'TERMINATED',
        effectiveUntil: new Date(),
      },
    });
  }
}
