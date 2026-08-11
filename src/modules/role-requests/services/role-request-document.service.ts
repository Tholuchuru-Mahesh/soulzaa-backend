import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DocumentCheckVerdict,
  Prisma,
  RoleRequestDocumentSlot,
  RoleRequestDocumentStatus,
  RoleRequestType,
} from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { S3Service } from 'src/infra/storage/s3.service';
import { STORAGE_CATEGORIES } from 'src/infra/storage/storage.constants';
import { REQUIRED_DOCUMENT_SLOTS } from '../constants/role-request.constants';
import {
  DOCUMENT_VERIFIER,
  DocumentCheckResult,
  DocumentVerifier,
} from '../interfaces/document-verifier.interface';
import { RoleRequestRoutingService } from './role-request-routing.service';

export interface SubmittedDocumentInput {
  slot: RoleRequestDocumentSlot;
  storageKey: string;
  filename: string;
  contentType: string;
}

/** An input document paired with the result of its automated pass. */
export interface PreparedDocument extends SubmittedDocumentInput {
  check: DocumentCheckResult;
}

/**
 * Documents attached to a role request: validating them on the way in, exposing
 * them to reviewers, and recording per-document decisions.
 *
 * The automated pass runs here rather than in the submit transaction, because
 * verification pulls every file out of S3 and hashes it — holding a database
 * transaction open across that much network is how connection pools die.
 */
@Injectable()
export class RoleRequestDocumentService {
  private readonly logger = new Logger(RoleRequestDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly routing: RoleRequestRoutingService,
    @Inject(DOCUMENT_VERIFIER) private readonly verifier: DocumentVerifier,
  ) {}

  /**
   * Validate the payload and run every document through the automated pass.
   *
   * Call this *before* opening the submit transaction. A document that fails
   * outright (wrong format, corrupt, undecodable) rejects the whole submission
   * with an explanation — putting an unopenable file in a human's queue wastes
   * the reviewer's time and the applicant's, and the applicant is the only one
   * who can fix it.
   */
  async prepare(
    type: RoleRequestType,
    subjectUserId: string,
    documents: SubmittedDocumentInput[],
  ): Promise<PreparedDocument[]> {
    const required = REQUIRED_DOCUMENT_SLOTS[type];
    if (required.length === 0 && documents.length === 0) return [];

    const seen = new Set<RoleRequestDocumentSlot>();
    for (const document of documents) {
      if (seen.has(document.slot)) {
        throw new BadRequestException(`Two documents were supplied for the ${document.slot} slot.`);
      }
      seen.add(document.slot);
      this.assertKeyBelongsToSubject(document.storageKey, subjectUserId);
    }

    const missing = required.filter((slot) => !seen.has(slot));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required document${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
      );
    }

    const prepared = await Promise.all(
      documents.map(async (document) => ({
        ...document,
        check: await this.verifier.verify({
          slot: document.slot,
          storageKey: document.storageKey,
          declaredContentType: document.contentType,
          subjectUserId,
        }),
      })),
    );

    const failed = prepared.filter((d) => d.check.verdict === DocumentCheckVerdict.FAILED);
    if (failed.length > 0) {
      const detail = failed
        .map((d) => `${d.slot}: ${d.check.findings.map((f) => f.detail).join(' ')}`)
        .join(' | ');
      throw new BadRequestException(`Some documents could not be accepted — ${detail}`);
    }

    const suspect = prepared.filter((d) => d.check.verdict === DocumentCheckVerdict.SUSPECT);
    if (suspect.length > 0) {
      this.logger.warn(
        `Role request for ${subjectUserId} carries ${suspect.length} flagged document(s): ` +
          suspect
            .map((d) => `${d.slot}[${d.check.findings.map((f) => f.code).join(',')}]`)
            .join(' '),
      );
    }

    return prepared;
  }

  /** Rows for the submit transaction. Kept separate so submit stays one transaction. */
  buildCreateData(
    requestId: string,
    prepared: PreparedDocument[],
  ): Prisma.RoleRequestDocumentCreateManyInput[] {
    return prepared.map((document) => ({
      requestId,
      slot: document.slot,
      storageKey: document.storageKey,
      filename: document.filename,
      contentType: document.contentType,
      sizeBytes: document.check.sizeBytes,
      checksum: document.check.checksum,
      checkVerdict: document.check.verdict,
      checkFindings: document.check.findings as unknown as Prisma.InputJsonValue,
    }));
  }

  /** Documents on a request, oldest slot order first. Metadata only — no URLs. */
  async listForRequest(requestId: string) {
    return this.prisma.roleRequestDocument.findMany({
      where: { requestId },
      orderBy: { slot: 'asc' },
    });
  }

  /**
   * A short-lived presigned URL for a reviewer.
   *
   * `UploadService.getDownloadUrl` is owner-scoped and would reject every
   * reviewer, since none of them uploaded the file. Access here is granted by
   * the reviewer's stage and territory instead — the same test that decides
   * whether they may act on the request at all, so an Official cannot browse
   * another region's identity documents.
   */
  async downloadUrl(documentId: string, actorId: string): Promise<{ downloadUrl: string }> {
    const document = await this.prisma.roleRequestDocument.findUnique({
      where: { id: documentId },
      include: { request: true },
    });
    if (!document) {
      throw new NotFoundException(`Document '${documentId}' not found`);
    }

    await this.assertMayReview(document.request, actorId);
    return { downloadUrl: await this.s3.getPresignedDownloadUrl(document.storageKey) };
  }

  /** Accept or reject one document, without deciding the request as a whole. */
  async review(
    documentId: string,
    actorId: string,
    status: RoleRequestDocumentStatus,
    notes?: string,
  ) {
    const document = await this.prisma.roleRequestDocument.findUnique({
      where: { id: documentId },
      include: { request: true },
    });
    if (!document) {
      throw new NotFoundException(`Document '${documentId}' not found`);
    }
    if (status === RoleRequestDocumentStatus.REJECTED && !notes?.trim()) {
      throw new BadRequestException('A rejection must say what is wrong with the document.');
    }

    await this.assertMayReview(document.request, actorId);

    return this.prisma.roleRequestDocument.update({
      where: { id: documentId },
      data: { status, reviewNotes: notes, reviewedByUserId: actorId, reviewedAt: new Date() },
    });
  }

  private async assertMayReview(
    request: {
      currentStage: string | null;
      regionId: string;
      stateId: string | null;
      countryId: string | null;
      reference: string;
    },
    actorId: string,
  ): Promise<void> {
    if (!request.currentStage) {
      throw new BadRequestException(
        `Request ${request.reference} is closed; its documents are no longer actionable.`,
      );
    }
    const allowed = await this.routing.canActAtStage(
      actorId,
      request.currentStage as Parameters<RoleRequestRoutingService['canActAtStage']>[1],
      { regionId: request.regionId, stateId: request.stateId, countryId: request.countryId },
    );
    if (!allowed) {
      throw new ForbiddenException(
        'You do not hold the reviewing role for this request in this territory.',
      );
    }
  }

  /**
   * Keys are `kyc-documents/{userId}/{uuid}.{ext}`. Without this check an
   * applicant could attach any object they knew the key of — including another
   * user's identity document, or their own avatar dressed up as a PAN card.
   */
  private assertKeyBelongsToSubject(key: string, subjectUserId: string): void {
    const [prefix, owner] = key.split('/');
    if (prefix !== STORAGE_CATEGORIES.KYC_DOCUMENT) {
      throw new BadRequestException(
        `Document key "${key}" is not a KYC upload. Upload documents with the ${STORAGE_CATEGORIES.KYC_DOCUMENT} category.`,
      );
    }
    if (owner !== subjectUserId) {
      throw new ForbiddenException(`Document key "${key}" does not belong to the applicant.`);
    }
  }
}
