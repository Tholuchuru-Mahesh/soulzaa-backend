import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

/**
 * Pure TypeScript CIDR parsing & verification utility.
 */
export function isIpInCidr(ip: string, cidr: string): boolean {
  try {
    // Normalize IPv4 mapped IPv6 e.g. ::ffff:192.0.2.1
    const cleanIp = ip.replace(/^::ffff:/i, '').trim();
    const cleanCidr = cidr.replace(/^::ffff:/i, '').trim();

    // Exact string match (works for IPv4, IPv6, localhost)
    if (cleanIp === cleanCidr) return true;
    if (cleanIp === '127.0.0.1' && (cleanCidr === '::1' || cleanCidr === '127.0.0.1/32'))
      return true;
    if (cleanIp === '::1' && (cleanCidr === '127.0.0.1' || cleanCidr === '::1/128')) return true;

    // IPv4 CIDR matching
    const [range, bitsStr] = cleanCidr.split('/');
    const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp);
    const rangeIsIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(range);

    if (isIpv4 && rangeIsIpv4) {
      const bits = bitsStr !== undefined ? parseInt(bitsStr, 10) : 32;
      if (isNaN(bits) || bits < 0 || bits > 32) return false;

      const ipNum = cleanIp
        .split('.')
        .reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);
      const rangeNum = range
        .split('.')
        .reduce((acc, octet) => ((acc << 8) + parseInt(octet, 10)) >>> 0, 0);

      if (bits === 0) return true;
      const mask = ((0xffffffff << (32 - bits)) & 0xffffffff) >>> 0;
      return (ipNum & mask) === (rangeNum & mask);
    }

    return false;
  } catch {
    return false;
  }
}

@Injectable()
export class StaffIpAllowlistService {
  private readonly logger = new Logger(StaffIpAllowlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Verifies if request IP matches any active approved CIDR for the staff account.
   * On first login (when no allowed IP is configured yet), automatically registers
   * the caller's initial IP into StaffAllowedIp and grants access.
   */
  async isIpAllowed(userId: string, requestIp: string): Promise<boolean> {
    if (!requestIp) return false;

    const cleanIp = requestIp.replace(/^::ffff:/i, '').trim();

    const allowedEntries = await this.prisma.staffAllowedIp.findMany({
      where: { userId, isActive: true },
    });

    if (allowedEntries.length === 0) {
      this.logger.log(`Auto-registering initial IP ${cleanIp} for staff user ${userId}`);
      const cidr = cleanIp.includes('/') ? cleanIp : `${cleanIp}/32`;
      await this.prisma.staffAllowedIp.create({
        data: {
          id: (await import('crypto')).randomUUID(),
          userId,
          cidr,
          label: 'Initial IP (auto-registered on first login)',
          addedBy: userId,
          isActive: true,
        },
      });
      return true;
    }

    for (const entry of allowedEntries) {
      if (isIpInCidr(cleanIp, entry.cidr)) {
        return true;
      }
    }

    this.logger.warn(`Access rejected for staff user ${userId} from unapproved IP ${cleanIp}`);
    return false;
  }

  /**
   * Adds an approved CIDR for a staff account and logs permanently to AuditLog.
   */
  async addIp(userId: string, cidr: string, label: string | undefined, addedBy: string) {
    const trimmed = cidr.trim();
    if (!trimmed) {
      throw new BadRequestException('CIDR cannot be empty');
    }

    const row = await this.prisma.staffAllowedIp.create({
      data: {
        userId,
        cidr: trimmed,
        label: label?.trim() ?? null,
        addedBy,
      },
    });

    // Permanent AuditLog record
    await this.prisma.auditLog.create({
      data: {
        actorId: addedBy,
        action: 'STAFF_IP_ADDED',
        resource: 'staff_allowed_ips',
        resourceId: row.id,
        targetUserId: userId,
        details: { cidr: trimmed, label: row.label },
      },
    });

    this.logger.log(`Added allowed IP ${trimmed} for staff user ${userId} by ${addedBy}`);
    return row;
  }

  /**
   * Soft-removes an approved CIDR and logs to AuditLog.
   */
  async removeIp(ipId: string, removedBy: string) {
    const existing = await this.prisma.staffAllowedIp.findUnique({
      where: { id: ipId },
    });

    if (!existing || !existing.isActive) {
      throw new NotFoundException('Allowed IP record not found or already inactive');
    }

    const updated = await this.prisma.staffAllowedIp.update({
      where: { id: ipId },
      data: {
        isActive: false,
        removedBy,
        removedAt: new Date(),
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: removedBy,
        action: 'STAFF_IP_REMOVED',
        resource: 'staff_allowed_ips',
        resourceId: ipId,
        targetUserId: existing.userId,
        details: { cidr: existing.cidr },
      },
    });

    this.logger.log(
      `Removed allowed IP ${existing.cidr} for staff user ${existing.userId} by ${removedBy}`,
    );
    return updated;
  }

  /**
   * Lists all active allowed IPs for a staff user.
   */
  async listIps(userId: string) {
    return this.prisma.staffAllowedIp.findMany({
      where: { userId, isActive: true },
      orderBy: { addedAt: 'desc' },
    });
  }

  /**
   * Lists all active registered devices for a staff user.
   */
  async listDevices(userId: string) {
    return this.prisma.userDevice.findMany({
      where: { userId, deletedAt: null },
      orderBy: { lastActiveAt: 'desc' },
    });
  }

  /**
   * Soft-removes / revokes a registered device for a staff account.
   */
  async removeDevice(userId: string, deviceId: string, removedBy: string) {
    const existing = await this.prisma.userDevice.findFirst({
      where: { id: deviceId, userId, deletedAt: null },
    });

    if (!existing) {
      throw new NotFoundException('Device not found or already removed');
    }

    const updated = await this.prisma.userDevice.update({
      where: { id: deviceId },
      data: { deletedAt: new Date(), trusted: false, verified: false },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: removedBy,
        action: 'STAFF_DEVICE_REMOVED',
        resource: 'user_device',
        resourceId: deviceId,
        targetUserId: userId,
        details: { deviceIdentifier: existing.deviceIdentifier, platform: existing.platform },
      },
    });

    this.logger.log(`Removed device ${deviceId} (${existing.deviceIdentifier}) for staff user ${userId} by ${removedBy}`);
    return updated;
  }

  /**
   * Returns an overview of moderator accounts with their registered devices.
   */
  async getOverview(roleFilter: string = 'MODERATOR') {
    const userRoles = await this.prisma.userRole.findMany({
      where: {
        role: { name: roleFilter },
      },
      include: {
        role: {
          select: { name: true },
        },
      },
    });

    const userIds = [...new Set(userRoles.map((ur) => ur.userId))];

    const [users, devices, allowedIps] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          mobile: true,
          status: true,
        },
      }),
      this.prisma.userDevice.findMany({
        where: { userId: { in: userIds }, deletedAt: null },
        orderBy: { lastActiveAt: 'desc' },
      }),
      this.prisma.staffAllowedIp.findMany({
        where: { userId: { in: userIds }, isActive: true },
        orderBy: { addedAt: 'desc' },
      }),
    ]);

    const userDetailsMap = new Map(users.map((u) => [u.id, u]));

    const userMap = new Map<
      string,
      {
        user: {
          id: string;
          username: string;
          fullName: string | null;
          email: string | null;
          mobile: string | null;
          status: string;
        };
        roles: string[];
        devices: any[];
        allowedIps: any[];
      }
    >();

    for (const ur of userRoles) {
      const u = userDetailsMap.get(ur.userId) ?? {
        id: ur.userId,
        username: 'Unknown',
        fullName: null,
        email: null,
        mobile: null,
        status: 'ACTIVE',
      };

      if (!userMap.has(ur.userId)) {
        userMap.set(ur.userId, {
          user: u,
          roles: [ur.role.name],
          devices: [],
          allowedIps: [],
        });
      } else {
        const entry = userMap.get(ur.userId)!;
        if (!entry.roles.includes(ur.role.name)) {
          entry.roles.push(ur.role.name);
        }
      }
    }

    for (const d of devices) {
      if (userMap.has(d.userId)) {
        userMap.get(d.userId)!.devices.push(d);
      }
    }

    for (const ip of allowedIps) {
      if (userMap.has(ip.userId)) {
        userMap.get(ip.userId)!.allowedIps.push(ip);
      }
    }

    return Array.from(userMap.values());
  }
}
