import { Inject, Injectable, Logger } from '@nestjs/common';
import { DocumentCheckVerdict, RoleRequestDocumentSlot } from '@prisma/client';
import { S3Service } from 'src/infra/storage/s3.service';
import {
  DocumentCheckFinding,
  DocumentCheckResult,
  DocumentToVerify,
  DocumentVerifier,
} from '../interfaces/document-verifier.interface';
import {
  KYC_PROVIDER,
  KycProvider,
  KycProviderUnavailableError,
} from '../interfaces/kyc-provider.interface';
import { IntegrityDocumentVerifier } from './integrity-document-verifier.service';

/**
 * Slots a KYC provider can actually adjudicate. A bank statement or a utility
 * bill has no issuing authority to check against, so those slots run integrity
 * checks only and go to a human — asking a provider to classify them would
 * produce "unrecognised" for every legitimate upload.
 */
const PROVIDER_BACKED_SLOTS: readonly RoleRequestDocumentSlot[] = [
  RoleRequestDocumentSlot.AADHAAR,
  RoleRequestDocumentSlot.PAN,
];

/**
 * The full document check: local integrity first, then the KYC provider.
 *
 * Ordering is deliberate. Integrity is cheap, local, and catches the cases that
 * would waste a paid API call — a corrupt file, an executable renamed .jpg. Only
 * a file that survives that is worth sending to the provider.
 *
 * The decision rule, per the configured strictness:
 *
 *   - provider says "this is not the document you claimed" → FAILED, rejected at
 *     the door with a message the applicant can act on
 *   - provider read it but could not confirm it against the issuing authority →
 *     SUSPECT, accepted and flagged for the reviewer
 *   - provider unreachable → SUSPECT, never FAILED. A vendor outage must not
 *     look like fraud, and blocking every applicant during one is a worse
 *     failure than letting a reviewer look manually.
 */
@Injectable()
export class CompositeDocumentVerifier implements DocumentVerifier {
  private readonly logger = new Logger(CompositeDocumentVerifier.name);

  constructor(
    private readonly integrity: IntegrityDocumentVerifier,
    private readonly s3: S3Service,
    @Inject(KYC_PROVIDER) private readonly provider: KycProvider,
  ) {}

  async verify(document: DocumentToVerify): Promise<DocumentCheckResult> {
    const base = await this.integrity.verify(document);

    // A file that already failed integrity is not worth a paid API call, and its
    // bytes may not even be decodable.
    if (base.verdict === DocumentCheckVerdict.FAILED) return base;
    if (!this.provider.enabled) return base;
    if (!PROVIDER_BACKED_SLOTS.includes(document.slot)) return base;

    const findings = [...base.findings, ...(await this.runProvider(document))];
    return { ...base, findings, verdict: verdictFrom(findings) };
  }

  private async runProvider(document: DocumentToVerify): Promise<DocumentCheckFinding[]> {
    try {
      const bytes = await this.s3.getObjectBuffer(document.storageKey);
      const result = await this.provider.check({
        slot: document.slot,
        bytes,
        contentType: document.declaredContentType,
        filename: document.storageKey.split('/').pop() ?? 'document',
      });

      if (result.detectedSlot === null) {
        return [
          {
            code: 'NOT_AN_IDENTITY_DOCUMENT',
            detail:
              `This does not look like a ${label(document.slot)}. ` +
              'Upload a clear photo or scan of the document itself.',
            severity: 'fatal',
          },
        ];
      }

      if (result.detectedSlot !== document.slot) {
        return [
          {
            code: 'WRONG_DOCUMENT_FOR_SLOT',
            detail:
              `This looks like a ${label(result.detectedSlot)}, but it was uploaded as the ` +
              `${label(document.slot)}. Check you picked the right file for each slot.`,
            severity: 'fatal',
          },
        ];
      }

      if (!result.sourceVerified) {
        return [
          {
            code: 'NOT_CONFIRMED_WITH_ISSUER',
            detail:
              `${this.provider.name} read the document but could not confirm it with the issuing ` +
              `authority${result.reason ? ` (${result.reason})` : ''}. Verify it by hand.`,
            severity: 'warn',
          },
        ];
      }

      return [];
    } catch (err) {
      if (err instanceof KycProviderUnavailableError) {
        // Deliberately not fatal — see the class comment.
        this.logger.error(
          `KYC provider unavailable, falling back to manual review: ${err.message}`,
        );
        return [
          {
            code: 'PROVIDER_UNAVAILABLE',
            detail:
              'Automatic identity verification could not run for this document. ' +
              'It needs checking by hand.',
            severity: 'warn',
          },
        ];
      }
      throw err;
    }
  }
}

function label(slot: RoleRequestDocumentSlot): string {
  return slot === RoleRequestDocumentSlot.PAN ? 'PAN card' : 'Aadhaar / National ID';
}

/** Same aggregation the integrity checker uses: any fatal fails, any warning is suspect. */
function verdictFrom(findings: DocumentCheckFinding[]): DocumentCheckVerdict {
  if (findings.some((f) => f.severity === 'fatal')) return DocumentCheckVerdict.FAILED;
  if (findings.length > 0) return DocumentCheckVerdict.SUSPECT;
  return DocumentCheckVerdict.PASSED;
}
