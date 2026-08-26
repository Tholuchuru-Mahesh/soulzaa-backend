import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { AuthorizationService } from 'src/modules/authorization/services/authorization.service';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';
import { UserSearchFilterDto } from '../dto/user-query.dto';
import { maskPrivilegedRole } from './role-masking.util';

@Injectable()
export class UserQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorizationService: AuthorizationService,
    private readonly media: MediaUrlResolver,
  ) {}

  /**
   * Complex User Search & Filtering with Pagination & Sorting
   */
  /**
   * `viewerIsSuperAdmin` gates role masking — an Admin must not be able to
   * identify a Super Admin (spec §1). Defaults to false so a caller that
   * forgets to pass it masks rather than leaks.
   */
  async searchUsers(dto: UserSearchFilterDto, viewerIsSuperAdmin = false) {
    const {
      query,
      role,
      countryId,
      stateId,
      regionId,
      status,
      dateFrom,
      dateTo,
      createdBy,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = dto;

    const skip = (page - 1) * limit;
    const where: any = {};

    // 1. Text Search across multiple fields
    if (query?.trim()) {
      const q = query.trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q);
      where.OR = [
        ...(isUuid ? [{ id: { equals: q } }] : []),
        { username: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { mobile: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
      ];
    }

    // 2. Filter by Account Status
    if (status) {
      where.status = status;
    }

    // 3. Filter by Registration Date
    if (dateFrom || dateTo) {
      where.createdAt = {};
      if (dateFrom) where.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.createdAt.lte = new Date(dateTo);
    }

    // 4. Filter by CreatedBy
    if (createdBy) {
      where.createdBy = createdBy;
    }

    // 5. Filter by Assigned Role & Geographic Scope via UserRole
    const userRoleWhere: any = {};
    if (role?.trim()) {
      userRoleWhere.role = {
        name: { equals: role.trim().toUpperCase() },
      };
    }

    if (countryId || stateId || regionId) {
      userRoleWhere.roleScopes = {
        some: {
          ...(countryId && { countryId }),
          ...(stateId && { stateId }),
          ...(regionId && { regionId }),
        },
      };
    }

    if (Object.keys(userRoleWhere).length > 0) {
      const matchingUserRoles = await this.prisma.userRole.findMany({
        where: userRoleWhere,
        select: { userId: true },
      });
      const matchedUserIds = matchingUserRoles.map((ur) => ur.userId);
      where.id = { in: matchedUserIds };
    }

    // 6. Execute Count & Select Queries
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          username: true,
          email: true,
          mobile: true,
          fullName: true,
          gender: true,
          country: true,
          status: true,
          isGuest: true,
          createdBy: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

    // 7. Attach User Roles & Scopes
    const userIds = users.map((u) => u.id);
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: { in: userIds } },
      include: {
        role: true,
        roleScopes: {
          include: {
            country: true,
            state: true,
            region: true,
          },
        },
      },
    });

    const roleMap = new Map<string, any[]>();
    for (const ur of userRoles) {
      const list = roleMap.get(ur.userId) ?? [];
      list.push({
        id: ur.role.id,
        name: maskPrivilegedRole(ur.role.name, viewerIsSuperAdmin),
        displayName: ur.role.displayName,
        assignedAt: ur.createdAt,
        scopes: ur.roleScopes.map((s) => ({
          scopeType: s.scopeType,
          country: s.country
            ? { id: s.country.id, code: s.country.code, name: s.country.name }
            : null,
          state: s.state ? { id: s.state.id, code: s.state.code, name: s.state.name } : null,
          region: s.region ? { id: s.region.id, code: s.region.code, name: s.region.name } : null,
        })),
      });
      roleMap.set(ur.userId, list);
    }

    // Count active agency relationships for each user (relevant for agencies)
    const agencyCreatorCounts = await this.prisma.agencyRelationship.groupBy({
      by: ['agencyId'],
      where: {
        agencyId: { in: userIds },
        status: 'ACTIVE',
      },
      _count: {
        hostId: true,
      },
    });

    const creatorCountMap = new Map<string, number>();
    for (const row of agencyCreatorCounts) {
      creatorCountMap.set(row.agencyId, row._count.hostId);
    }

    const items = users.map((u) => {
      const roles = roleMap.get(u.id) ?? [];
      const agencyRole = roles.find((r) => r.name === 'AGENCY' || r.name === 'COIN_SELLER');
      return {
        ...u,
        assignedRoles: roles,
        creatorsCount: creatorCountMap.get(u.id) ?? 0,
        agencyJoinedAt: agencyRole ? agencyRole.assignedAt : u.createdAt,
      };
    });

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      items,
    };
  }

  /**
   * Detailed User Profile Inspection (Roles, Inherited Permissions, Scopes, Audit Logs)
   */
  /** See searchUsers for why `viewerIsSuperAdmin` defaults to false. */
  async getUserProfileDetails(userId: string, viewerIsSuperAdmin = false) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    const [
      userRoles,
      effectivePermissions,
      recentAuditLogs,
      stats,
      referral,
      verification,
      familyMember,
      agencyRel,
      coinSellerRel,
      wallet,
      roomLogs,
      videoLogs,
      giftTransactions,
      recharges,
      gamePlays,
      latestSession,
    ] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        include: {
          role: true,
          roleScopes: {
            include: {
              country: true,
              state: true,
              region: true,
            },
          },
        },
      }),
      this.authorizationService.getEffectivePermissions(userId),
      this.prisma.auditLog.findMany({
        where: {
          OR: [{ actorId: userId }, { resourceId: userId }],
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.userStatistics.findUnique({
        where: { userId },
      }),
      this.prisma.referralRelationship.findUnique({
        where: { refereeId: userId },
      }),
      this.prisma.userVerification.findUnique({
        where: { userId },
      }),
      this.prisma.familyMember.findUnique({
        where: { userId },
      }),
      this.prisma.agencyRelationship.findFirst({
        where: { hostId: userId, status: 'ACTIVE' },
      }),
      this.prisma.coinSellerRelationship.findFirst({
        where: { buyerId: userId, status: 'ACTIVE' },
      }),
      this.prisma.wallet.findUnique({
        where: { userId },
      }),
      this.prisma.roomLog.findMany({
        where: { actorId: userId, action: 'JOINED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.videoRoomLog.findMany({
        where: { actorId: userId, action: 'JOINED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.giftTransaction.findMany({
        where: { senderId: userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.purchaseOrder.findMany({
        where: { userId, status: 'COMPLETED' },
        include: { package: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.gameParticipant.findMany({
        where: { userId },
        orderBy: { joinedAt: 'desc' },
        take: 10,
      }),
      this.prisma.userSession.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Resolve details sequentially or concurrently
    let referredBy = null;
    if (referral) {
      const referrer = await this.prisma.user.findUnique({
        where: { id: referral.referrerId },
      });
      if (referrer) {
        referredBy = referrer.username;
      }
    }

    let family = null;
    if (familyMember) {
      const fam = await this.prisma.family.findUnique({
        where: { id: familyMember.familyId },
      });
      if (fam) {
        family = {
          familyId: fam.id,
          familyName: fam.name,
          familyRole: familyMember.role,
          id: fam.id,
          name: fam.name,
          role: familyMember.role,
          logo: fam.logo,
          logoKey: fam.logo,
        };
      }
    }

    let agency = null;
    if (agencyRel) {
      const agencyUser = await this.prisma.user.findUnique({
        where: { id: agencyRel.agencyId },
      });
      if (agencyUser) {
        agency = {
          agencyId: agencyRel.agencyId,
          agencyName: agencyUser.fullName || agencyUser.username,
          agencyRole: 'HOST',
          id: agencyRel.agencyId,
          name: agencyUser.fullName || agencyUser.username,
          role: 'HOST',
        };
      }
    }

    const userHasAgencyRole = userRoles.some((ur) => ur.role.name === 'AGENCY');
    if (userHasAgencyRole && !agency) {
      agency = {
        agencyId: user.id,
        agencyName: user.fullName || user.username,
        agencyRole: 'OWNER',
        id: user.id,
        name: user.fullName || user.username,
        role: 'OWNER',
      };
    }

    let coinSeller = null;
    if (coinSellerRel) {
      const sellerUser = await this.prisma.user.findUnique({
        where: { id: coinSellerRel.sellerId },
      });
      if (sellerUser) {
        coinSeller = {
          id: coinSellerRel.sellerId,
          name: sellerUser.fullName || sellerUser.username,
          email: sellerUser.email,
        };
      }
    }

    const userHasCoinSellerRole = userRoles.some((ur) => ur.role.name === 'COIN_SELLER');
    if (userHasCoinSellerRole && !coinSeller) {
      coinSeller = {
        id: user.id,
        name: user.fullName || user.username,
        email: user.email,
      };
    }

    // Resolve name mappings for logs
    const audioRoomIds = roomLogs.map((rl) => rl.roomId);
    const audioRooms = await this.prisma.audioRoom.findMany({
      where: { id: { in: audioRoomIds } },
    });
    const audioRoomMap = new Map(audioRooms.map((r) => [r.id, r]));

    const giftIds = giftTransactions.map((gt) => gt.giftId);
    const gifts = await this.prisma.gift.findMany({
      where: { id: { in: giftIds } },
    });
    const giftMap = new Map(gifts.map((g) => [g.id, g]));

    const receiverIds = giftTransactions.map((gt) => gt.receiverId);
    const receivers = await this.prisma.user.findMany({
      where: { id: { in: receiverIds } },
    });
    const receiverMap = new Map(receivers.map((r) => [r.id, r]));

    const definitionIds = gamePlays.map((gp) => gp.definitionId);
    const definitions = await this.prisma.gameDefinition.findMany({
      where: { id: { in: definitionIds } },
    });
    const definitionMap = new Map(definitions.map((d) => [d.id, d]));

    const mappedRoomLogs = roomLogs.map((rl) => {
      const room = audioRoomMap.get(rl.roomId);
      return {
        id: rl.id,
        type: 'stream',
        action: `Joined audio room “${room ? room.name : 'Unknown'}”`,
        resource: `Room ID: AR${rl.roomId.replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        createdAt: rl.createdAt,
      };
    });

    const mappedVideoLogs = videoLogs.map((vl) => {
      return {
        id: vl.id,
        type: 'stream',
        action: `Creator live stream attendance`,
        resource: `Stream ID: LS${vl.roomId.replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        createdAt: vl.createdAt,
      };
    });

    const mappedGiftTxns = giftTransactions.map((gt) => {
      const gift = giftMap.get(gt.giftId);
      const receiver = receiverMap.get(gt.receiverId);
      return {
        id: gt.id,
        type: 'gift',
        action: `Sent gift “${gift ? gift.name : 'Gift'}” x${gt.quantity} to ${receiver ? receiver.username : 'user'}`,
        resource: `Gift ID: GFT${gt.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        createdAt: gt.createdAt,
      };
    });

    const mappedRecharges = recharges.map((r) => ({
      id: r.id,
      type: 'recharge',
      action: `Coin recharge - ${r.package ? r.package.name : `Package ${r.totalCoins}`}`,
      resource: `Order ID: ${r.orderNumber}`,
      createdAt: r.createdAt,
    }));

    const mappedGamePlays = gamePlays.map((gp) => {
      const definition = definitionMap.get(gp.definitionId);
      const shortTxnId = gp.stakeTxnId
        ? `TRX${gp.stakeTxnId.replace(/-/g, '').slice(0, 6).toUpperCase()}`
        : '';
      return {
        id: gp.id,
        type: 'game',
        action: `Played game “${definition ? definition.name : 'Game'}”`,
        resource: `Game ID: GM${gp.sessionId.replace(/-/g, '').slice(0, 6).toUpperCase()}${shortTxnId ? `, Transaction ID: ${shortTxnId}` : ''}`,
        createdAt: gp.joinedAt,
      };
    });

    let mappedWalletTxns: any[] = [];
    if (wallet) {
      const walletTxns = await this.prisma.walletTransaction.findMany({
        where: {
          ledgerEntries: {
            some: {
              walletId: wallet.id,
            },
          },
          NOT: {
            ledgerEntries: {
              some: {
                reason: {
                  in: ['GIFT_SEND', 'GIFT_RECEIVE', 'GAME_STAKE', 'GAME_PAYOUT', 'RECHARGE'],
                },
              },
            },
          },
        },
        include: {
          ledgerEntries: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      mappedWalletTxns = walletTxns.map((t) => {
        const ledger = t.ledgerEntries.find((e) => e.walletId === wallet.id);
        const isDebit = ledger?.type === 'DEBIT';

        let type = 'system';
        let action = isDebit ? 'Transferred Coins' : 'Received Transfer';
        let resource = `Amount: ${t.amount.toString()}`;

        if (ledger?.reason === 'COSMETIC_PURCHASE') {
          type = 'recharge';
          const meta = t.metadata as any;
          action = `Bought cosmetic: “${meta?.name || 'Cosmetic'}”`;
          resource = `Cost: ${t.amount.toString()} gold coins`;
        }

        return {
          id: t.id,
          type,
          action,
          resource,
          createdAt: t.createdAt,
        };
      });
    }

    const combinedLogs = [
      ...recentAuditLogs.map((log) => ({
        id: log.id,
        type: 'system',
        action: log.action,
        resource: `${log.resource || ''} ${log.resourceId || ''}`.trim(),
        createdAt: log.createdAt,
      })),
      ...mappedRoomLogs,
      ...mappedVideoLogs,
      ...mappedGiftTxns,
      ...mappedRecharges,
      ...mappedGamePlays,
      ...mappedWalletTxns,
    ]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 10);

    const level = stats ? stats.level : 1;
    const vipLevel = stats ? stats.wealthLevel : 0;
    const kycVerifiedAt = verification && verification.verified ? verification.reviewedAt : null;
    const ageVerifiedAt = verification && verification.verified ? verification.reviewedAt : null;

    const formattedRoles = userRoles.map((ur) => ({
      userRoleId: ur.id,
      roleId: ur.role.id,
      roleName: maskPrivilegedRole(ur.role.name, viewerIsSuperAdmin),
      displayName: ur.role.displayName,
      description: ur.role.description,
      assignedAt: ur.createdAt,
      scopes: ur.roleScopes.map((s) => ({
        scopeType: s.scopeType,
        country: s.country
          ? { id: s.country.id, code: s.country.code, name: s.country.name }
          : null,
        state: s.state ? { id: s.state.id, code: s.state.code, name: s.state.name } : null,
        region: s.region ? { id: s.region.id, code: s.region.code, name: s.region.name } : null,
      })),
    }));

    const agencyRole = formattedRoles.find(
      (r) => r.roleName === 'AGENCY' || r.roleName === 'COIN_SELLER',
    );
    const agencyJoinedAt = agencyRole ? agencyRole.assignedAt : user.createdAt;

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      mobile: user.mobile,
      fullName: user.fullName,
      gender: user.gender,
      dateOfBirth: user.dateOfBirth,
      country: user.country,
      preferredLanguage: user.preferredLanguage,
      status: user.status,
      isGuest: user.isGuest,
      emailVerifiedAt: user.emailVerifiedAt,
      mobileVerifiedAt: user.mobileVerifiedAt,
      createdAt: user.createdAt,
      agencyJoinedAt,
      updatedAt: user.updatedAt,
      lastLoginAt: latestSession ? latestSession.createdAt : null,
      level,
      vipLevel,
      referredBy,
      kycVerifiedAt,
      ageVerifiedAt,
      family,
      agency,
      coinSeller,
      assignedRoles: formattedRoles,
      inheritedPermissions: effectivePermissions,
      recentAuditLogs: combinedLogs,
    };
  }

  /**
   * User Audit Logs History
   */
  async getUserAuditHistory(userId: string, page = 1, limit = 20) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID '${userId}' not found`);
    }

    const skip = (page - 1) * limit;

    const where = {
      OR: [{ actorId: userId }, { resourceId: userId }],
    };

    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      logs,
    };
  }

  async getPendingVerifications() {
    const verifications = await this.prisma.userVerification.findMany({
      where: {
        status: 'PENDING',
        type: 'CREATOR',
      },
      orderBy: {
        submittedAt: 'desc',
      },
    });

    if (verifications.length === 0) return [];

    const userIds = verifications.map((v) => v.userId);
    const users = await this.prisma.user.findMany({
      where: {
        id: { in: userIds },
      },
      select: {
        id: true,
        username: true,
        fullName: true,
      },
    });

    const userMap = new Map(users.map((u) => [u.id, u]));

    const result = await Promise.all(
      verifications.map(async (v) => {
        const user = userMap.get(v.userId);
        let platform = '';
        let handle = '';
        let selfieUrl = '';
        let category = v.category || '';

        if (v.documentKey) {
          try {
            const data = JSON.parse(v.documentKey);
            if (data && typeof data === 'object') {
              platform = data.platform || '';
              handle = data.handle || '';
              if (data.category && !category) category = data.category;
              if (data.selfieKey) {
                selfieUrl = (await this.media.resolve(data.selfieKey)) || '';
              }
            }
          } catch {
            // documentKey is not JSON — it is the storage key itself.
            selfieUrl = (await this.media.resolve(v.documentKey)) || '';
          }
        }

        return {
          userId: v.userId,
          username: user?.username || '',
          fullName: user?.fullName || '',
          selfieUrl,
          platform,
          handle,
          category: category || 'Creator',
          submittedAt: v.submittedAt,
          status: v.status,
        };
      }),
    );

    return result;
  }

  /**
   * KPI Statistics for Creator Management Screen
   */
  async getCreatorStats() {
    const [totalCount, audioCount, videoCount, gamingCount, verifiedCount] = await Promise.all([
      // Total creators: all users who submitted creator verification or are verified
      this.prisma.userVerification.count({
        where: {
          OR: [
            { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
            { type: 'CREATOR' },
            { verified: true },
          ],
        },
      }),
      // Audio creators: Category matching AUDIO or SINGER
      this.prisma.userVerification.count({
        where: {
          AND: [
            {
              OR: [
                { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
                { type: 'CREATOR' },
                { verified: true },
              ],
            },
            {
              OR: [{ category: { in: ['AUDIO', 'Audio', 'SINGER', 'Singer', 'singer', 'audio'] } }],
            },
          ],
        },
      }),
      // Video creators: Category matching VIDEO, STREAMER
      this.prisma.userVerification.count({
        where: {
          AND: [
            {
              OR: [
                { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
                { type: 'CREATOR' },
                { verified: true },
              ],
            },
            {
              category: { in: ['VIDEO', 'Video', 'STREAMER', 'Streamer', 'video', 'streamer'] },
            },
          ],
        },
      }),
      // Gaming creators: Category matching GAMER, GAMING, MAGICIAN, COMEDIAN
      this.prisma.userVerification.count({
        where: {
          AND: [
            {
              OR: [
                { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
                { type: 'CREATOR' },
                { verified: true },
              ],
            },
            {
              category: {
                in: [
                  'GAMER',
                  'Gamer',
                  'gamer',
                  'GAMING',
                  'Gaming',
                  'gaming',
                  'MAGICIAN',
                  'Magician',
                  'magician',
                  'COMEDIAN',
                  'Comedian',
                  'comedian',
                ],
              },
            },
          ],
        },
      }),
      // Verified creators: verified boolean true or status APPROVED
      this.prisma.userVerification.count({
        where: {
          OR: [{ verified: true }, { status: 'APPROVED' }],
        },
      }),
    ]);

    return {
      total: totalCount,
      audio: audioCount,
      video: videoCount,
      gaming: gamingCount,
      verified: verifiedCount,
    };
  }

  /**
   * Search and filter creators with full live data for Creator List table
   */
  async searchCreators(filter: {
    query?: string;
    tab?: string;
    countryId?: string;
    status?: string;
    category?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, Number(filter.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filter.limit) || 20));
    const skip = (page - 1) * limit;

    // 1. Find all users who applied for creator verification or hold creator roles
    const [appliedVerifications, creatorRoles] = await Promise.all([
      this.prisma.userVerification.findMany({
        where: {
          OR: [
            { status: { in: ['PENDING', 'APPROVED', 'REJECTED'] } },
            { type: 'CREATOR' },
            { verified: true },
          ],
        },
        select: { userId: true },
      }),
      this.prisma.userRole.findMany({
        where: {
          role: {
            name: { in: ['CREATOR', 'HOST', 'OFFICIAL_HOST', 'AGENCY_HOST'] },
          },
        },
        select: { userId: true },
      }),
    ]);

    const creatorUserIdsSet = new Set<string>();
    for (const v of appliedVerifications) creatorUserIdsSet.add(v.userId);
    for (const r of creatorRoles) creatorUserIdsSet.add(r.userId);

    const creatorUserIds = Array.from(creatorUserIdsSet);

    if (creatorUserIds.length === 0) {
      return {
        items: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }

    const where: any = {
      id: { in: creatorUserIds },
      isHiddenAccount: false,
    };

    if (filter.query && filter.query.trim()) {
      const q = filter.query.trim();
      where.OR = [
        { username: { contains: q, mode: 'insensitive' } },
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ];
      if (q.length === 36 && q.includes('-')) {
        where.OR.push({ id: q });
      }
    }

    if (filter.countryId && filter.countryId !== 'ALL') {
      where.countryId = filter.countryId;
    }

    if (filter.status && filter.status !== 'ALL') {
      where.status = filter.status.toUpperCase();
    }

    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          locationCountry: true,
        },
      }),
    ]);

    const userIds = users.map((u) => u.id);

    const [verifications, statistics, profiles, agencyRelationships] = await Promise.all([
      this.prisma.userVerification.findMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.userStatistics.findMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.userProfile.findMany({
        where: { userId: { in: userIds } },
      }),
      this.prisma.agencyRelationship.findMany({
        where: { hostId: { in: userIds }, status: 'ACTIVE' },
      }),
    ]);

    const agencyIds = agencyRelationships.map((ar) => ar.agencyId);
    const agencyUsers =
      agencyIds.length > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: agencyIds } },
            select: { id: true, fullName: true, username: true },
          })
        : [];

    const verificationMap = new Map(verifications.map((v) => [v.userId, v]));
    const statisticsMap = new Map(statistics.map((s) => [s.userId, s]));
    const profileMap = new Map(profiles.map((p) => [p.userId, p]));
    const agencyMap = new Map(agencyRelationships.map((ar) => [ar.hostId, ar.agencyId]));
    const agencyUserMap = new Map(agencyUsers.map((au) => [au.id, au.fullName || au.username]));

    const items = await Promise.all(
      users.map(async (user) => {
        const ver = verificationMap.get(user.id);
        const stat = statisticsMap.get(user.id);
        const prof = profileMap.get(user.id);
        const agId = agencyMap.get(user.id);
        const agName = agId ? agencyUserMap.get(agId) || 'Independent' : 'Independent';

        let category = ver?.category || 'Creator';
        let platform = '';
        let handle = '';
        let selfieUrl = '';

        if (ver?.documentKey) {
          try {
            const data = JSON.parse(ver.documentKey);
            if (data && typeof data === 'object') {
              if (data.category && category === 'Creator') category = data.category;
              platform = data.platform || '';
              handle = data.handle || '';
              if (data.selfieKey) {
                selfieUrl = (await this.media.resolve(data.selfieKey)) || '';
              }
            }
          } catch {
            // raw key
          }
        }

        let verificationStatus: 'Verified' | 'Pending' | 'Rejected' | 'Unverified' = 'Unverified';
        if (ver?.verified || ver?.status === 'APPROVED') {
          verificationStatus = 'Verified';
        } else if (ver?.status === 'PENDING') {
          verificationStatus = 'Pending';
        } else if (ver?.status === 'REJECTED') {
          verificationStatus = 'Rejected';
        }

        const avatarUrl = prof?.avatarKey ? await this.media.resolve(prof.avatarKey) : null;
        const coinsEarned = stat?.coinsReceived ? Number(stat.coinsReceived) : 0;
        const followers = stat?.followersCount ?? 0;

        return {
          id: user.id,
          username: user.username,
          fullName: user.fullName || user.username,
          avatarUrl,
          category: category.charAt(0).toUpperCase() + category.slice(1).toLowerCase(),
          agency: agName,
          agencyId: agId || null,
          followers,
          verification: verificationStatus,
          revenue: coinsEarned,
          status: user.status === 'ACTIVE' ? 'Active' : 'Inactive',
          createdAt: user.createdAt,
          country: user.locationCountry?.name || user.country || 'Global',
          platform,
          handle,
          selfieUrl,
          rejectionReason: ver?.rejectionReason || null,
        };
      }),
    );

    // Tab-level filtering if specified
    let filteredItems = items;
    if (filter.tab && filter.tab !== 'ALL') {
      const tabUpper = filter.tab.toUpperCase();
      if (tabUpper === 'VERIFIED') {
        filteredItems = filteredItems.filter((i) => i.verification === 'Verified');
      } else if (tabUpper === 'AUDIO') {
        filteredItems = filteredItems.filter(
          (i) =>
            i.category.toLowerCase().includes('audio') ||
            i.category.toLowerCase().includes('singer'),
        );
      } else if (tabUpper === 'VIDEO') {
        filteredItems = filteredItems.filter(
          (i) =>
            i.category.toLowerCase().includes('video') ||
            i.category.toLowerCase().includes('streamer'),
        );
      } else if (tabUpper === 'GAMING') {
        filteredItems = filteredItems.filter(
          (i) =>
            i.category.toLowerCase().includes('gamer') ||
            i.category.toLowerCase().includes('gaming') ||
            i.category.toLowerCase().includes('magician') ||
            i.category.toLowerCase().includes('comedian'),
        );
      } else if (tabUpper === 'INFLUENCERS') {
        filteredItems = filteredItems.filter(
          (i) =>
            i.category.toLowerCase().includes('influencer') ||
            i.category.toLowerCase().includes('artist'),
        );
      }
    }

    return {
      items: filteredItems,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Update creator category
   */
  async updateCreatorCategory(userId: string, category: string) {
    const cleanCategory = category.trim();
    return this.prisma.userVerification.upsert({
      where: { userId },
      create: {
        userId,
        category: cleanCategory,
        type: 'CREATOR',
        status: 'NONE',
        verified: false,
      },
      update: {
        category: cleanCategory,
      },
    });
  }

  /**
   * Assign or update creator agency relationship
   */
  async assignCreatorAgency(userId: string, agencyId: string) {
    // 1. Deactivate existing active relationships for host
    await this.prisma.agencyRelationship.updateMany({
      where: { hostId: userId, status: 'ACTIVE' },
      data: { status: 'INACTIVE', effectiveUntil: new Date() },
    });

    if (!agencyId || agencyId === 'INDEPENDENT') {
      return { success: true, message: 'Creator set to independent.' };
    }

    // 2. Upsert new active relationship
    return this.prisma.agencyRelationship.upsert({
      where: {
        agencyId_hostId: {
          agencyId,
          hostId: userId,
        },
      },
      create: {
        agencyId,
        hostId: userId,
        status: 'ACTIVE',
        effectiveFrom: new Date(),
      },
      update: {
        status: 'ACTIVE',
        effectiveFrom: new Date(),
        effectiveUntil: null,
      },
    });
  }

  /**
   * List members / hosts assigned to a specific agency
   */
  async getAgencyMembers(agencyId: string) {
    const relationships = await this.prisma.agencyRelationship.findMany({
      where: { agencyId, status: 'ACTIVE' },
      orderBy: { effectiveFrom: 'desc' },
      select: { hostId: true, effectiveFrom: true },
    });

    if (relationships.length === 0) {
      return { items: [], total: 0 };
    }

    const hostIds = relationships.map((r) => r.hostId);
    const users = await this.prisma.user.findMany({
      where: { id: { in: hostIds } },
      select: {
        id: true,
        username: true,
        fullName: true,
        email: true,
        country: true,
        status: true,
        createdAt: true,
      },
    });

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: { in: hostIds } },
      include: { role: true },
    });

    const roleMap = new Map<string, string[]>();
    for (const ur of userRoles) {
      const list = roleMap.get(ur.userId) ?? [];
      list.push(ur.role.name);
      roleMap.set(ur.userId, list);
    }

    const items = users.map((u) => ({
      ...u,
      roles: roleMap.get(u.id) ?? ['USER'],
    }));

    return { items, total: items.length };
  }
}
