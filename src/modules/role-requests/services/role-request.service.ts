import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  RoleRequestActionType,
  RoleRequestStage,
  RoleRequestStatus,
  RoleRequestType,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { RoleResolver } from 'src/modules/authorization/services/role-resolver.service';
import { RoleService } from 'src/modules/authorization/services/role.service';
import {
  ENTRY_STAGE,
  GRANTED_ROLE,
  OPEN_STATUSES,
  PIPELINE_VERSION,
  TERMINAL_STATUSES,
  nextStage,
} from '../constants/role-request.constants';
import {
  RoleRequestDocumentService,
  SubmittedDocumentInput,
} from './role-request-document.service';
import { RoleRequestRoutingService } from './role-request-routing.service';

export interface SubmitRoleRequestInput {
  type: RoleRequestType;
  subjectUserId: string;
  formData?: Record<string, unknown>;
  /** @deprecated Untyped mirror of `documents`; kept for older callers. */
  documentKeys?: string[];
  documents?: SubmittedDocumentInput[];
}

export interface StageActionInput {
  requestId: string;
  actorId: string;
  notes?: string;
  checklistSnapshot?: Record<string, unknown>;
}

/**
 * The role request lifecycle.
 *
 * A request climbs OFFICIAL → MANAGER → ADMIN; approval at the final stage grants
 * the role. Every transition is validated against the current status and stage
 * rather than trusted from the caller, and every action is appended to an
 * immutable audit trail — an approval chain that cannot be reconstructed
 * afterwards is not an approval chain.
 */
@Injectable()
export class RoleRequestService {
  private readonly logger = new Logger(RoleRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: RoleRequestRoutingService,
    private readonly roleService: RoleService,
    private readonly documents: RoleRequestDocumentService,
    private readonly roles: RoleResolver,
  ) {}

  /**
   * Files a new request.
   *
   * The reference counter and the request row are written in one transaction so a
   * failure cannot burn a reference number, and the partial unique index — not an
   * application check — is what stops two concurrent submits creating two open
   * chains for the same person.
   *
   * Documents are validated and checked *before* the transaction opens: the pass
   * downloads and hashes every file, and a rejected document must abort the
   * submission without having burned a reference number.
   *
   * Moderator is an anonymous internal enforcement role, not a self-service
   * application: the spec requires it be recommended by an Official, never
   * self-registered. `role_request.submit` is a base permission every member
   * holds (for AGENCY/COIN_SELLER self-applications), so MODERATOR needs its
   * own gate here rather than relying on the controller's permission check.
   */
  async submit(input: SubmitRoleRequestInput, initiatedByUserId: string) {
    if (input.type === RoleRequestType.MODERATOR) {
      if (initiatedByUserId === input.subjectUserId) {
        throw new ForbiddenException('Moderator accounts cannot self-register.');
      }
      if (!(await this.roles.hasRole(initiatedByUserId, 'OFFICIAL'))) {
        throw new ForbiddenException('Only an Official may recommend a Moderator candidate.');
      }
    }

    // The applicant typed their country and state on the form, so hand those
    // to the resolver: they are a far better source than anything that can be
    // inferred, and without them an ordinary account has no location at all.
    const geography = await this.routing.resolveGeography(input.subjectUserId, input.formData);
    const stage = ENTRY_STAGE[input.type];

    const prepared = await this.documents.prepare(
      input.type,
      input.subjectUserId,
      input.documents ?? [],
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        const year = new Date().getUTCFullYear();
        const counter = await tx.roleRequestCounter.upsert({
          where: { year },
          create: { year, lastSequence: 1 },
          update: { lastSequence: { increment: 1 } },
        });

        const reference = `RR-${year}-${String(counter.lastSequence).padStart(6, '0')}`;

        const request = await tx.roleRequest.create({
          data: {
            reference,
            type: input.type,
            subjectUserId: input.subjectUserId,
            initiatedByUserId,
            status: RoleRequestStatus.SUBMITTED,
            currentStage: stage,
            currentStageEnteredAt: new Date(),
            pipelineVersion: PIPELINE_VERSION,
            formData: (input.formData ?? {}) as never,
            // Mirror of the typed `documents` rows below, for older readers.
            documentKeys: prepared.length
              ? prepared.map((d) => d.storageKey)
              : (input.documentKeys ?? []),
            regionId: geography.regionId,
            stateId: geography.stateId,
            countryId: geography.countryId,
          },
        });

        await tx.roleRequestAction.create({
          data: {
            requestId: request.id,
            sequence: 1,
            stage,
            action: RoleRequestActionType.SUBMIT,
            actorUserId: initiatedByUserId,
            actorRole: 'INITIATOR',
            stageEnteredAt: request.currentStageEnteredAt!,
          },
        });

        if (prepared.length > 0) {
          await tx.roleRequestDocument.createMany({
            data: this.documents.buildCreateData(request.id, prepared),
          });
        }

        return request;
      });
    } catch (err) {
      // The partial unique index rejects a second open request for the same
      // subject and type.
      if ((err as { code?: string }).code === 'P2002') {
        throw new ConflictException(`An open ${input.type} request already exists for this user.`);
      }
      throw err;
    }
  }

  /** Loads a request and asserts the actor may act on it at its current stage. */
  private async loadActionable(requestId: string, actorId: string) {
    const request = await this.prisma.roleRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException(`Role request '${requestId}' not found`);
    }

    if (TERMINAL_STATUSES.includes(request.status)) {
      throw new BadRequestException(
        `Request ${request.reference} is already ${request.status} and cannot be actioned.`,
      );
    }

    if (!request.currentStage) {
      throw new BadRequestException(`Request ${request.reference} has no active stage.`);
    }

    const allowed = await this.routing.canActAtStage(actorId, request.currentStage, {
      regionId: request.regionId,
      stateId: request.stateId,
      countryId: request.countryId,
    });

    if (!allowed) {
      throw new ForbiddenException(
        `You do not hold the reviewing role for the ${request.currentStage} stage in this territory.`,
      );
    }

    return request;
  }

  /** Appends to the immutable trail. Sequence is per request, gap-free. */
  private async recordAction(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    params: {
      requestId: string;
      stage: RoleRequestStage;
      action: RoleRequestActionType;
      actorUserId: string;
      actorRole: string;
      stageEnteredAt: Date;
      notes?: string;
      checklistSnapshot?: Record<string, unknown>;
    },
  ) {
    const last = await tx.roleRequestAction.findFirst({
      where: { requestId: params.requestId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    await tx.roleRequestAction.create({
      data: {
        requestId: params.requestId,
        sequence: (last?.sequence ?? 0) + 1,
        stage: params.stage,
        action: params.action,
        actorUserId: params.actorUserId,
        actorRole: params.actorRole,
        notes: params.notes,
        checklistSnapshot: (params.checklistSnapshot ?? undefined) as never,
        stageEnteredAt: params.stageEnteredAt,
      },
    });
  }

  /** Moves the request to the next stage, or approves it if this is the last. */
  async advance(input: StageActionInput) {
    const request = await this.loadActionable(input.requestId, input.actorId);
    const stage = request.currentStage!;
    const next = nextStage(stage);

    if (!next) {
      // Advancing past the final stage is an approval.
      return this.approve(input);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.recordAction(tx, {
        requestId: request.id,
        stage,
        action: RoleRequestActionType.ADVANCE,
        actorUserId: input.actorId,
        actorRole: stage,
        stageEnteredAt: request.currentStageEnteredAt ?? request.submittedAt,
        notes: input.notes,
        checklistSnapshot: input.checklistSnapshot,
      });

      return tx.roleRequest.update({
        where: { id: request.id },
        data: {
          status: RoleRequestStatus.IN_REVIEW,
          currentStage: next,
          currentStageEnteredAt: new Date(),
        },
      });
    });
  }

  /** Sends the request back to the subject for more information. */
  async sendBack(input: StageActionInput) {
    const request = await this.loadActionable(input.requestId, input.actorId);
    const stage = request.currentStage!;

    return this.prisma.$transaction(async (tx) => {
      await this.recordAction(tx, {
        requestId: request.id,
        stage,
        action: RoleRequestActionType.SEND_BACK,
        actorUserId: input.actorId,
        actorRole: stage,
        stageEnteredAt: request.currentStageEnteredAt ?? request.submittedAt,
        notes: input.notes,
      });

      return tx.roleRequest.update({
        where: { id: request.id },
        // Stage is preserved: the same reviewer picks it up again once the
        // subject responds, rather than the chain restarting from the bottom.
        data: { status: RoleRequestStatus.NEEDS_INFO },
      });
    });
  }

  /** Approves the request and grants the role in the same transaction. */
  async approve(input: StageActionInput) {
    const request = await this.loadActionable(input.requestId, input.actorId);
    const stage = request.currentStage!;

    const role = await this.prisma.role.findFirst({
      where: { name: GRANTED_ROLE[request.type] },
    });
    if (!role) {
      throw new BadRequestException(
        `Role '${GRANTED_ROLE[request.type]}' is not seeded; cannot approve.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.recordAction(tx, {
        requestId: request.id,
        stage,
        action: RoleRequestActionType.APPROVE,
        actorUserId: input.actorId,
        actorRole: stage,
        stageEnteredAt: request.currentStageEnteredAt ?? request.submittedAt,
        notes: input.notes,
        checklistSnapshot: input.checklistSnapshot,
      });

      return tx.roleRequest.update({
        where: { id: request.id },
        data: {
          status: RoleRequestStatus.APPROVED,
          currentStage: null,
          decidedAt: new Date(),
          decidedByUserId: input.actorId,
        },
      });
    });

    // Granting goes through RoleService so the authorisation cache is
    // invalidated the same way it is for a manual assignment.
    await this.roleService.assignRoleToUser(
      { userId: request.subjectUserId, roleId: role.id },
      input.actorId,
    );

    // Sync location and name from role request if present
    const formData = request.formData as Record<string, any> | null;
    const updateData: Record<string, any> = {};
    if (formData?.fullName) updateData.fullName = formData.fullName;
    if (request.countryId || formData?.countryId) updateData.countryId = request.countryId || formData?.countryId;
    if (request.stateId || formData?.stateId) updateData.stateId = request.stateId || formData?.stateId;
    if (request.regionId || formData?.regionId) updateData.regionId = request.regionId || formData?.regionId;
    if (Object.keys(updateData).length > 0) {
      await this.prisma.user.update({
        where: { id: request.subjectUserId },
        data: updateData,
      });
    }

    return updated;
  }

  /** Rejects the request. Terminal. */
  async reject(input: StageActionInput & { reason: string }) {
    const request = await this.loadActionable(input.requestId, input.actorId);
    const stage = request.currentStage!;

    return this.prisma.$transaction(async (tx) => {
      await this.recordAction(tx, {
        requestId: request.id,
        stage,
        action: RoleRequestActionType.REJECT,
        actorUserId: input.actorId,
        actorRole: stage,
        stageEnteredAt: request.currentStageEnteredAt ?? request.submittedAt,
        notes: input.notes,
      });

      return tx.roleRequest.update({
        where: { id: request.id },
        data: {
          status: RoleRequestStatus.REJECTED,
          currentStage: null,
          decidedAt: new Date(),
          decidedByUserId: input.actorId,
          outcomeReason: input.reason,
        },
      });
    });
  }

  /** The subject withdraws their own request. */
  async withdraw(requestId: string, subjectUserId: string) {
    const request = await this.prisma.roleRequest.findUnique({ where: { id: requestId } });
    if (!request) {
      throw new NotFoundException(`Role request '${requestId}' not found`);
    }
    if (request.subjectUserId !== subjectUserId) {
      throw new ForbiddenException('Only the subject of a request may withdraw it.');
    }
    if (TERMINAL_STATUSES.includes(request.status)) {
      throw new BadRequestException(`Request ${request.reference} is already ${request.status}.`);
    }

    return this.prisma.$transaction(async (tx) => {
      await this.recordAction(tx, {
        requestId: request.id,
        stage: request.currentStage ?? RoleRequestStage.OFFICIAL,
        action: RoleRequestActionType.WITHDRAW,
        actorUserId: subjectUserId,
        actorRole: 'SUBJECT',
        stageEnteredAt: request.currentStageEnteredAt ?? request.submittedAt,
      });

      return tx.roleRequest.update({
        where: { id: request.id },
        data: { status: RoleRequestStatus.WITHDRAWN, currentStage: null, decidedAt: new Date() },
      });
    });
  }

  /** The reviewer queue for an actor, narrowed to their territory. */
  async queue(actorId: string, limit = 25, offset = 0) {
    const scopeWhere = await this.routing.queueFilter(actorId);

    const where = {
      AND: [scopeWhere, { status: { in: [...OPEN_STATUSES] } }],
    };

    const [total, items] = await Promise.all([
      this.prisma.roleRequest.count({ where }),
      this.prisma.roleRequest.findMany({
        where,
        orderBy: { submittedAt: 'asc' },
        take: Math.min(limit, 100),
        skip: offset,
      }),
    ]);

    return { total, items };
  }

  /** A request with its full, ordered audit trail and its documents. */
  async findById(requestId: string) {
    const request = await this.prisma.roleRequest.findUnique({
      where: { id: requestId },
      include: {
        actions: { orderBy: { sequence: 'asc' } },
        documents: { orderBy: { slot: 'asc' } },
      },
    });
    if (!request) {
      throw new NotFoundException(`Role request '${requestId}' not found`);
    }
    return request;
  }

  /**
   * The applicant's own latest request of a type — what the mobile status screen
   * polls. Returns null rather than 404 so a user who has never applied gets a
   * clean "no application" state instead of an error.
   *
   * The document view is deliberately narrower than the reviewer's: the
   * applicant sees which slots they filled and any rejection note written *for*
   * them, but not `checkFindings`. Handing back "DUPLICATE_ACROSS_APPLICANTS"
   * would tell someone gaming the system exactly which check caught them.
   */
  async findMine(subjectUserId: string, type: RoleRequestType) {
    const request = await this.prisma.roleRequest.findFirst({
      where: { subjectUserId, type },
      orderBy: { submittedAt: 'desc' },
      include: {
        actions: { orderBy: { sequence: 'asc' } },
        documents: { orderBy: { slot: 'asc' } },
      },
    });

    if (!request) return null;

    return {
      id: request.id,
      reference: request.reference,
      type: request.type,
      status: request.status,
      currentStage: request.currentStage,
      submittedAt: request.submittedAt,
      decidedAt: request.decidedAt,
      outcomeReason: request.outcomeReason,
      documents: request.documents.map((document) => ({
        id: document.id,
        slot: document.slot,
        filename: document.filename,
        status: document.status,
        reviewNotes: document.reviewNotes,
      })),
      timeline: request.actions.map((action) => ({
        stage: action.stage,
        action: action.action,
        actedAt: action.actedAt,
      })),
    };
  }
}
