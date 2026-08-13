import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuditLogQueryDto } from '../dto/audit-log-query.dto';

export interface CreateAuditLogParams {
  actorId: string;
  actorRole?: string;
  action: string;
  resource: string;
  resourceId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  userAgent?: string;
  status?: string;
  // Task 28 — extended audit context
  targetUserId?: string;
  roomId?: string;
  region?: string;
}

/** Parse a browser name from a raw User-Agent string (best-effort). */
function parseBrowser(ua?: string): string | null {
  if (!ua) return null;
  if (ua.includes('Edg/') || ua.includes('EdgA/')) return 'Edge';
  if (ua.includes('OPR/') || ua.includes('Opera/')) return 'Opera';
  if (ua.includes('Chrome/') && !ua.includes('Chromium/')) return 'Chrome';
  if (ua.includes('Safari/') && !ua.includes('Chrome/')) return 'Safari';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('MSIE') || ua.includes('Trident/')) return 'IE';
  return null;
}

/** Parse an OS name from a raw User-Agent string (best-effort). */
function parseOs(ua?: string): string | null {
  if (!ua) return null;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Windows NT/i.test(ua)) return 'Windows';
  if (/Macintosh/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return null;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Infrastructure framework method to record a privileged audit log entry.
   */
  async logAction(params: CreateAuditLogParams) {
    try {
      return await this.prisma.auditLog.create({
        data: {
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: params.action,
          resource: params.resource,
          resourceId: params.resourceId,
          details: params.details ?? undefined,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
          status: params.status ?? 'SUCCESS',
          targetUserId: params.targetUserId,
          roomId: params.roomId,
          region: params.region,
          browser: parseBrowser(params.userAgent),
          os: parseOs(params.userAgent),
        },
      });
    } catch (err) {
      // Audit logging framework should be resilient and never crash caller business logic
      this.logger.error(
        `Failed to record audit log: ${(err as Error).message}`,
        (err as Error).stack,
      );
      return null;
    }
  }


  /**
   * Query audit log records with pagination and filters.
   */
  async getAuditLogs(query: AuditLogQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.actorId) where.actorId = query.actorId;
    if (query.action) where.action = query.action;
    if (query.resource) where.resource = query.resource;
    if (query.resourceId) where.resourceId = query.resourceId;

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
