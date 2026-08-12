import { RoleRequestDocumentSlot } from '@prisma/client';

/**
 * What a KYC provider concluded about one document.
 *
 * Deliberately a small, provider-neutral shape: every vendor returns a
 * differently-named blob, and letting those names leak into the verifier would
 * mean rewriting the decision logic every time the contract changes.
 */
export interface KycCheckResult {
  /**
   * The document the provider believes this is, normalised to our slots.
   * Null when the provider could not classify it at all — which is the signal
   * that someone uploaded a holiday photo rather than an ID.
   */
  detectedSlot: RoleRequestDocumentSlot | null;

  /**
   * Whether the provider confirmed the document against the issuing authority
   * (UIDAI, NSDL…). False means "we read it but did not or could not confirm
   * it", which is weaker than a positive verification but not a rejection.
   */
  sourceVerified: boolean;

  /** Provider's own confidence in the extraction, 0..1, when it reports one. */
  confidence: number | null;

  /**
   * Identity fields the provider read off the document. Only ever used for
   * cross-checking against the application; never logged, because these are
   * exactly the values that must not end up in a log aggregator.
   */
  extracted: {
    documentNumber?: string;
    name?: string;
    dateOfBirth?: string;
  };

  /** Provider-specific reason text, surfaced to the reviewer, not the applicant. */
  reason?: string;
}

/** Raised when the provider itself is unreachable or errored, as opposed to rejecting a document. */
export class KycProviderUnavailableError extends Error {}

export interface KycProviderDocument {
  slot: RoleRequestDocumentSlot;
  /** Raw bytes as stored. Providers take either a file upload or a signed URL. */
  bytes: Buffer;
  contentType: string;
  filename: string;
}

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

export interface KycProvider {
  /** Human-readable provider name, used in findings and logs. */
  readonly name: string;

  /** False when no credentials are configured, so the pipeline can skip the call. */
  readonly enabled: boolean;

  /**
   * Inspect one document.
   *
   * Throws [KycProviderUnavailableError] for transport and provider-side
   * failures. It must not throw to signal "this document is not an Aadhaar" —
   * that is a result, and the difference decides whether an applicant is
   * blocked or merely flagged.
   */
  check(document: KycProviderDocument): Promise<KycCheckResult>;
}
