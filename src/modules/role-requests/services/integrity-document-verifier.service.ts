import { Injectable, Logger } from '@nestjs/common';
import { DocumentCheckVerdict } from '@prisma/client';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { S3Service } from 'src/infra/storage/s3.service';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import {
  DocumentCheckFinding,
  DocumentCheckResult,
  DocumentToVerify,
  DocumentVerifier,
} from '../interfaces/document-verifier.interface';

/**
 * Magic-byte signatures for the three types KYC uploads allow. Sniffing the
 * bytes is the only way to know what a file *is* — `Content-Type` is chosen by
 * the client, so a renamed executable arrives claiming to be a JPEG.
 */
const SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
];

/**
 * Editor watermarks left in image metadata. Their presence is not proof of
 * tampering — plenty of people crop a scan in Photoshop — so this only ever
 * raises a warning for a human to weigh.
 */
const EDITOR_SIGNATURES = [
  'Adobe Photoshop',
  'GIMP',
  'Snapseed',
  'PicsArt',
  'Canva',
  'Pixlr',
  'Paint.NET',
  'Inkscape',
];

/** Metadata lives near the front of the file; don't scan megabytes of pixels. */
const METADATA_SCAN_BYTES = 64 * 1024;

/** Below this, a "scan of an ID" is a thumbnail or a placeholder, not a document. */
const MIN_PLAUSIBLE_BYTES = 15 * 1024;

/** Below this on the short edge, text on an ID card will not be legible. */
const MIN_PLAUSIBLE_EDGE_PX = 300;

/**
 * The automated pass that runs before a request reaches a human reviewer.
 *
 * What it establishes: the file is one of the formats we accept, it is
 * structurally intact, it is large enough to read, and it has not already been
 * submitted by a *different* applicant.
 *
 * What it deliberately does not claim: that a document is genuine. Nothing here
 * contacts an issuing authority, so a well-made forgery passes every check. The
 * verdict is triage for the reviewer's queue, never a substitute for the review —
 * which is why even PASSED documents still land in a human's queue.
 */
@Injectable()
export class IntegrityDocumentVerifier implements DocumentVerifier {
  private readonly logger = new Logger(IntegrityDocumentVerifier.name);

  constructor(
    private readonly s3: S3Service,
    private readonly prisma: PrismaService,
  ) {}

  async verify(document: DocumentToVerify): Promise<DocumentCheckResult> {
    const buffer = await this.s3.getObjectBuffer(document.storageKey);
    const checksum = createHash('sha256').update(buffer).digest('hex');
    const findings: DocumentCheckFinding[] = [];

    const detectedContentType = this.sniff(buffer);

    if (!detectedContentType) {
      findings.push({
        code: 'UNRECOGNISED_FORMAT',
        detail: 'File is not a JPEG, PNG or PDF regardless of what it was uploaded as.',
        severity: 'fatal',
      });
    } else if (detectedContentType !== document.declaredContentType) {
      findings.push({
        code: 'CONTENT_TYPE_MISMATCH',
        detail: `Uploaded as ${document.declaredContentType} but the bytes are ${detectedContentType}.`,
        severity: 'fatal',
      });
    }

    if (buffer.length < MIN_PLAUSIBLE_BYTES) {
      findings.push({
        code: 'IMPLAUSIBLY_SMALL',
        detail: `${buffer.length} bytes is too small to be a readable document scan.`,
        severity: 'warn',
      });
    }

    if (detectedContentType === 'application/pdf') {
      findings.push(...this.checkPdf(buffer));
    } else if (detectedContentType) {
      findings.push(...(await this.checkImage(buffer)));
    }

    findings.push(...this.checkForEditorWatermarks(buffer));
    findings.push(...(await this.checkForReuseByOtherApplicants(checksum, document.subjectUserId)));

    return {
      verdict: this.verdictFrom(findings),
      findings,
      checksum,
      sizeBytes: buffer.length,
      detectedContentType,
    };
  }

  /** Identify the real format from leading bytes. */
  private sniff(buffer: Buffer): string | null {
    for (const signature of SIGNATURES) {
      if (buffer.length < signature.bytes.length) continue;
      if (signature.bytes.every((byte, i) => buffer[i] === byte)) return signature.mime;
    }
    return null;
  }

  /**
   * PDF structure. A truncated upload keeps a valid header but loses its
   * trailer, and an encrypted PDF opens to a password prompt the reviewer
   * cannot answer.
   */
  private checkPdf(buffer: Buffer): DocumentCheckFinding[] {
    const findings: DocumentCheckFinding[] = [];
    // The trailer sits at the very end; a truncated file is the case worth
    // catching, so only the tail needs reading.
    const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString('latin1');
    if (!tail.includes('%%EOF')) {
      findings.push({
        code: 'MALFORMED_PDF',
        detail: 'PDF has no end-of-file marker — the upload is truncated or corrupt.',
        severity: 'fatal',
      });
    }

    const body = buffer.toString('latin1');
    if (/\/Encrypt\b/.test(body)) {
      findings.push({
        code: 'ENCRYPTED_PDF',
        detail: 'PDF is password-protected and cannot be opened by a reviewer.',
        severity: 'warn',
      });
    }

    // `/Type /Page` (singular) marks a leaf page; `/Pages` is the tree node.
    const pageCount = (body.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pageCount === 0) {
      findings.push({
        code: 'NO_PAGES',
        detail: 'No page objects found in the PDF.',
        severity: 'warn',
      });
    }

    return findings;
  }

  /** Image decodability and legibility. */
  private async checkImage(buffer: Buffer): Promise<DocumentCheckFinding[]> {
    const findings: DocumentCheckFinding[] = [];
    try {
      const meta = await sharp(buffer).metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;

      if (width === 0 || height === 0) {
        findings.push({
          code: 'UNDECODABLE_IMAGE',
          detail: 'Image headers parsed but no dimensions could be read.',
          severity: 'fatal',
        });
      } else if (Math.min(width, height) < MIN_PLAUSIBLE_EDGE_PX) {
        findings.push({
          code: 'LOW_RESOLUTION',
          detail: `${width}×${height} is too small to read text on an identity document.`,
          severity: 'warn',
        });
      }
    } catch (err) {
      // A file that passed the magic-byte check but will not decode is
      // corrupt — the reviewer would open it to a broken image.
      findings.push({
        code: 'UNDECODABLE_IMAGE',
        detail: `Image could not be decoded: ${err instanceof Error ? err.message : 'unknown error'}`,
        severity: 'fatal',
      });
    }
    return findings;
  }

  private checkForEditorWatermarks(buffer: Buffer): DocumentCheckFinding[] {
    const head = buffer.subarray(0, METADATA_SCAN_BYTES).toString('latin1');
    const found = EDITOR_SIGNATURES.filter((name) => head.includes(name));
    if (found.length === 0) return [];
    return [
      {
        code: 'EDITED_WITH_IMAGE_EDITOR',
        detail: `Metadata names an image editor (${found.join(', ')}). Common for a cropped scan, but worth a look.`,
        severity: 'warn',
      },
    ];
  }

  /**
   * The same bytes submitted by someone else.
   *
   * Scoped to *other* applicants on purpose: one person legitimately reuses a
   * bank statement as both bank proof and address proof, and flagging that would
   * train reviewers to ignore the warning.
   */
  private async checkForReuseByOtherApplicants(
    checksum: string,
    subjectUserId: string,
  ): Promise<DocumentCheckFinding[]> {
    const matches = await this.prisma.roleRequestDocument.findMany({
      where: {
        checksum,
        request: { subjectUserId: { not: subjectUserId } },
      },
      select: { request: { select: { reference: true } } },
      take: 5,
    });

    if (matches.length === 0) return [];

    const references = matches.map((m) => m.request.reference).join(', ');
    return [
      {
        code: 'DUPLICATE_ACROSS_APPLICANTS',
        detail: `Byte-identical file already submitted by a different applicant (${references}).`,
        severity: 'warn',
      },
    ];
  }

  private verdictFrom(findings: DocumentCheckFinding[]): DocumentCheckVerdict {
    if (findings.some((f) => f.severity === 'fatal')) return DocumentCheckVerdict.FAILED;
    if (findings.length > 0) return DocumentCheckVerdict.SUSPECT;
    return DocumentCheckVerdict.PASSED;
  }
}
