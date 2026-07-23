import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';

@Injectable()
export class DashboardValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertWidgetExists(id: string): Promise<void> {
    const widget = await this.prisma.dashboardWidget.findUnique({
      where: { id },
    });
    if (!widget) {
      throw new NotFoundException(`Widget with ID "${id}" not found.`);
    }
  }

  assertLayoutIntegrity(gridConfig: Record<string, unknown>): void {
    if (!gridConfig || typeof gridConfig !== 'object') {
      throw new BadRequestException('Invalid grid layout configuration. Layout must be a valid JSON object.');
    }
  }

  assertRoleCanViewWidget(userRole: string, widgetVisibleRoles?: string[]): void {
    if (!widgetVisibleRoles || widgetVisibleRoles.length === 0) return;
    if (!widgetVisibleRoles.includes(userRole)) {
      throw new ForbiddenException(`User role "${userRole}" is not permitted to view this widget.`);
    }
  }

  assertValidExportFormat(format: string): void {
    const valid = ['CSV', 'EXCEL', 'PDF', 'JSON'];
    if (!valid.includes(format.toUpperCase())) {
      throw new BadRequestException(`Unsupported export format: "${format}".`);
    }
  }
}
