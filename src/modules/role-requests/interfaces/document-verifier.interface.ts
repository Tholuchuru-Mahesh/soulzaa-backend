import { DocumentCheckVerdict, RoleRequestDocumentSlot } from '@prisma/client';

/**
 * One thing the automated pass noticed about a document.
 *
 * `severity` drives the overall verdict: any `fatal` finding fails the document
 * outright, any `warn` marks it SUSPECT for a closer human look, and a document
 * with neither passes.
 */
export interface DocumentCheckFinding {
  code: string;
  detail: string;
  severity: 'fatal' | 'warn';
}

export interface DocumentCheckResult {
  verdict: DocumentCheckVerdict;
  findings: DocumentCheckFinding[];
  /** SHA-256 of the stored bytes, computed here rather than trusted from the client. */
  checksum: string;
  /** Real byte length as stored, not the size the client declared. */
  sizeBytes: number;
  /** Format inferred from magic bytes; null when nothing recognised it. */
  detectedContentType: string | null;
}

export interface DocumentToVerify {
  slot: RoleRequestDocumentSlot;
  storageKey: string;
  declaredContentType: string;
  /** Whose application this is — duplicate detection only fires across *different* applicants. */
  subjectUserId: string;
}

/**
 * Injection token for the verifier. Swapping the integrity checker for a
 * government-source KYC provider (DigiLocker, Signzy, IDfy…) is a matter of
 * binding a different class to this token; nothing in the review flow changes.
 */
export const DOCUMENT_VERIFIER = Symbol('DOCUMENT_VERIFIER');

export interface DocumentVerifier {
  verify(document: DocumentToVerify): Promise<DocumentCheckResult>;
}
