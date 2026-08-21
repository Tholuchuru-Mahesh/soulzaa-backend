import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InventoryRecipientType } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { SocketManager } from 'src/infra/socket/socket.manager';
import { WorkforceScopeService } from 'src/modules/mobile-workforce/services/workforce-scope.service';
import { DistributeInventoryDto, CreateInventoryItemDto } from '../dto/official-inventory.dto';

@Injectable()
export class OfficialInventoryService {
  private readonly logger = new Logger(OfficialInventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: WorkforceScopeService,
    @Optional() private readonly socketManager?: SocketManager,
  ) {}

  /**
   * List inventory items and summary metric cards for the Official or SuperAdmin.
   */
  async getInventory(
    officialId?: string,
    params?: { category?: string; search?: string; limit?: number; offset?: number },
  ) {
    const whereClause: any = officialId ? { officialId } : {};

    if (params?.category && params.category.toUpperCase() !== 'ALL') {
      const catKey = params.category.toUpperCase();
      // Map display categories to enum
      if (catKey === 'GIFTS' || catKey === 'GIFT') whereClause.category = 'GIFT';
      else if (catKey === 'FRAMES' || catKey === 'FRAME') whereClause.category = 'FRAME';
      else if (
        catKey === 'ENTRY_EFFECTS' ||
        catKey === 'ENTRY_EFFECT' ||
        catKey === 'ENTRY EFFECTS'
      )
        whereClause.category = 'ENTRY_EFFECT';
      else if (catKey === 'THEMES' || catKey === 'THEME') whereClause.category = 'THEME';
      else if (catKey === 'REWARDS' || catKey === 'REWARD') whereClause.category = 'REWARD';
      else if (catKey === 'BADGES' || catKey === 'BADGE') whereClause.category = 'BADGE';
    }

    if (params?.search && params.search.trim().length > 0) {
      whereClause.OR = [
        { name: { contains: params.search.trim(), mode: 'insensitive' } },
        { relatedEventName: { contains: params.search.trim(), mode: 'insensitive' } },
        { source: { contains: params.search.trim(), mode: 'insensitive' } },
      ];
    }

    const [items, allOfficialItems] = await Promise.all([
      this.prisma.officialInventoryItem.findMany({
        where: whereClause,
        orderBy: { receivedAt: 'desc' },
        take: params?.limit ?? 50,
        skip: params?.offset ?? 0,
      }),
      this.prisma.officialInventoryItem.findMany({
        where: officialId ? { officialId } : {},
        select: {
          availableQty: true,
          lowStockThreshold: true,
          receivedAt: true,
          totalReceivedQty: true,
        },
      }),
    ]);

    // Metric Calculations
    const totalItems = allOfficialItems.length;
    const available = allOfficialItems.reduce((acc, curr) => acc + curr.availableQty, 0);
    const lowStock = allOfficialItems.filter(
      (item) => item.availableQty > 0 && item.availableQty <= (item.lowStockThreshold || 20),
    ).length;

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const recentlyReceived = allOfficialItems
      .filter((item) => new Date(item.receivedAt) >= sevenDaysAgo)
      .reduce((acc, curr) => acc + (curr.totalReceivedQty || curr.availableQty), 0);

    return {
      metrics: {
        totalItems,
        available,
        lowStock,
        recentlyReceived,
      },
      items,
    };
  }

  /**
   * Get single asset details with stock breakdown.
   */
  async getItemById(officialId: string | undefined, id: string) {
    const where = officialId ? { id, officialId } : { id };
    const item = await this.prisma.officialInventoryItem.findFirst({
      where,
      include: {
        dispatches: {
          orderBy: { dispatchedAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!item) {
      throw new NotFoundException(`Inventory item ${id} not found`);
    }

    return item;
  }

  /**
   * Distribute inventory assets to an Agency, Creator, or User.
   */
  async distribute(officialId: string, dto: DistributeInventoryDto) {
    const item = await this.prisma.officialInventoryItem.findFirst({
      where: { id: dto.inventoryItemId },
    });

    if (!item) {
      throw new NotFoundException(`Inventory item ${dto.inventoryItemId} not found`);
    }

    if (item.availableQty < dto.quantity) {
      throw new BadRequestException(
        `Insufficient stock. Available: ${item.availableQty}, Requested: ${dto.quantity}`,
      );
    }

    // Atomic update stock and create dispatch log
    const [updatedItem, dispatch] = await this.prisma.$transaction([
      this.prisma.officialInventoryItem.update({
        where: { id: item.id },
        data: {
          availableQty: { decrement: dto.quantity },
          distributedQty: { increment: dto.quantity },
        },
      }),
      this.prisma.officialInventoryDispatch.create({
        data: {
          officialId,
          inventoryItemId: item.id,
          recipientType: dto.recipientType,
          recipientId: dto.recipientId,
          recipientName: dto.recipientName,
          recipientCode: dto.recipientCode,
          quantity: dto.quantity,
          reason: dto.reason,
          remarks: dto.remarks,
          dispatchedAt: new Date(),
        },
      }),
    ]);

    this.logger.log(
      `Distributed ${dto.quantity} of ${item.name} to ${dto.recipientName} (${dto.recipientType})`,
    );

    try {
      this.socketManager?.emitToNamespace('/notifications', 'inventory:update', {
        action: 'distributed',
        itemId: item.id,
        dispatchId: dispatch.id,
        updatedAvailable: updatedItem.availableQty,
      });
    } catch {
      // Socket emission is best-effort
    }

    return {
      success: true,
      message: 'Distribution successful',
      dispatch,
      item: updatedItem,
    };
  }

  /**
   * Autocomplete recipients for distribution scoped to official territory.
   */
  async getRecipients(
    officialId: string | undefined,
    type: InventoryRecipientType,
    query?: string,
  ) {
    const q = query?.trim() || '';
    const scopeWhere = officialId ? await this.scope.userScopeFilter(officialId) : {};

    if (type === 'AGENCY') {
      const agencies = await this.prisma.user.findMany({
        where: {
          ...scopeWhere,
          roles: { has: 'AGENCY' },
          ...(q
            ? {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { fullName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        take: 20,
        select: { id: true, username: true, fullName: true },
      });

      if (agencies.length > 0) {
        return agencies.map((a) => ({
          id: a.id,
          name: a.fullName || a.username,
          code: a.username,
          displayName: `${a.fullName || a.username} (@${a.username})`,
        }));
      }

      const users = await this.prisma.user.findMany({
        where: {
          ...scopeWhere,
          ...(q
            ? {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { fullName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        take: 20,
        select: { id: true, username: true, fullName: true },
      });

      return users.map((u) => ({
        id: u.id,
        name: u.fullName || u.username,
        code: u.username,
        displayName: `${u.fullName || u.username} (@${u.username})`,
      }));
    }

    if (type === 'CREATOR') {
      const users = await this.prisma.user.findMany({
        where: {
          ...scopeWhere,
          ...(q
            ? {
                OR: [
                  { username: { contains: q, mode: 'insensitive' } },
                  { fullName: { contains: q, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        take: 20,
        select: { id: true, username: true, fullName: true },
      });

      return users.map((u) => ({
        id: u.id,
        name: u.fullName || u.username,
        code: u.username,
        displayName: `${u.fullName || u.username} (@${u.username})`,
      }));
    }

    // Default USER
    const users = await this.prisma.user.findMany({
      where: {
        ...scopeWhere,
        ...(q
          ? {
              OR: [
                { username: { contains: q, mode: 'insensitive' } },
                { fullName: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      take: 20,
      select: { id: true, username: true, fullName: true },
    });

    return users.map((u) => ({
      id: u.id,
      name: u.fullName || u.username,
      code: u.username,
      displayName: `${u.fullName || u.username} (@${u.username})`,
    }));
  }

  /**
   * Allocate/grant inventory items to an Official (Superadmin / Admin action).
   */
  async grantInventoryItem(dto: CreateInventoryItemDto) {
    if (!dto.officialId) {
      throw new BadRequestException('Target Official ID or Username is required');
    }

    const official = await this.prisma.user.findFirst({
      where: {
        OR: [
          { id: dto.officialId },
          { username: { equals: dto.officialId.trim(), mode: 'insensitive' } },
          { email: { equals: dto.officialId.trim(), mode: 'insensitive' } },
        ],
      },
    });

    if (!official) {
      throw new NotFoundException(`Official user '${dto.officialId}' not found in database`);
    }

    const targetOfficialId = official.id;

    const item = await this.prisma.officialInventoryItem.create({
      data: {
        officialId: targetOfficialId,
        name: dto.name,
        category: dto.category,
        description: dto.description,
        thumbnailUrl: dto.thumbnailUrl,
        availableQty: dto.availableQty,
        totalReceivedQty: dto.availableQty,
        source: dto.source || 'SuperAdmin',
        relatedEventName: dto.relatedEventName,
        lowStockThreshold: dto.lowStockThreshold || 20,
        receivedAt: new Date(),
      },
    });

    this.logger.log(
      `Granted ${dto.availableQty} units of ${dto.name} to Official ${targetOfficialId}`,
    );

    try {
      this.socketManager?.emitToNamespace('/notifications', 'inventory:update', {
        action: 'granted',
        itemId: item.id,
        officialId: targetOfficialId,
      });
    } catch {
      // Best-effort notification
    }

    return item;
  }

  /**
   * List officials for inventory allocation picker.
   */
  async getOfficials() {
    let officials = await this.prisma.user.findMany({
      where: {
        roles: {
          hasSome: ['OFFICIAL', 'COUNTRY_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'],
        },
      },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        roles: true,
      },
      take: 50,
    });

    if (officials.length === 0) {
      officials = await this.prisma.user.findMany({
        take: 50,
        select: {
          id: true,
          username: true,
          fullName: true,
          email: true,
          roles: true,
        },
      });
    }

    return officials;
  }

  /**
   * Get transaction / dispatch history.
   */
  async getTransactions(officialId?: string, limit = 50, offset = 0) {
    const where = officialId ? { officialId } : {};
    const [transactions, total] = await Promise.all([
      this.prisma.officialInventoryDispatch.findMany({
        where,
        include: { inventoryItem: true },
        orderBy: { dispatchedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.officialInventoryDispatch.count({
        where,
      }),
    ]);

    return { total, transactions };
  }
}
