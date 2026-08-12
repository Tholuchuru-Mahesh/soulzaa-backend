import { DocumentCheckVerdict, RoleRequestDocumentSlot } from '@prisma/client';
import { S3Service } from 'src/infra/storage/s3.service';
import { DocumentCheckResult } from '../interfaces/document-verifier.interface';
import {
  KycCheckResult,
  KycProvider,
  KycProviderUnavailableError,
} from '../interfaces/kyc-provider.interface';
import { CompositeDocumentVerifier } from './composite-document-verifier.service';
import { IntegrityDocumentVerifier } from './integrity-document-verifier.service';

const cleanIntegrity: DocumentCheckResult = {
  verdict: DocumentCheckVerdict.PASSED,
  findings: [],
  checksum: 'a'.repeat(64),
  sizeBytes: 400_000,
  detectedContentType: 'image/jpeg',
};

const aadhaarUpload = {
  slot: RoleRequestDocumentSlot.AADHAAR,
  storageKey: 'kyc-documents/user-1/doc.jpg',
  declaredContentType: 'image/jpeg',
  subjectUserId: 'user-1',
};

function providerReturning(result: Partial<KycCheckResult>): KycProvider {
  return {
    name: 'test-provider',
    enabled: true,
    check: jest.fn().mockResolvedValue({
      detectedSlot: RoleRequestDocumentSlot.AADHAAR,
      sourceVerified: true,
      confidence: 0.98,
      extracted: {},
      ...result,
    } satisfies KycCheckResult),
  };
}

describe('CompositeDocumentVerifier', () => {
  const integrity = { verify: jest.fn() };
  const s3 = { getObjectBuffer: jest.fn() };

  function build(provider: KycProvider) {
    return new CompositeDocumentVerifier(
      integrity as unknown as IntegrityDocumentVerifier,
      s3 as unknown as S3Service,
      provider,
    );
  }

  beforeEach(() => {
    jest.clearAllMocks();
    integrity.verify.mockResolvedValue(cleanIntegrity);
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('bytes'));
  });

  it('rejects a photo the provider cannot classify as any identity document', async () => {
    // The reported bug: a random gallery image sailed through every check.
    const verifier = build(providerReturning({ detectedSlot: null }));

    const result = await verifier.verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
    const finding = result.findings.find((f) => f.code === 'NOT_AN_IDENTITY_DOCUMENT');
    expect(finding?.detail).toContain('Aadhaar');
  });

  it('rejects a PAN card uploaded into the Aadhaar slot', async () => {
    const verifier = build(providerReturning({ detectedSlot: RoleRequestDocumentSlot.PAN }));

    const result = await verifier.verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
    expect(result.findings.map((f) => f.code)).toContain('WRONG_DOCUMENT_FOR_SLOT');
  });

  it('passes a document the provider confirmed with the issuing authority', async () => {
    const verifier = build(providerReturning({}));

    const result = await verifier.verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.PASSED);
    expect(result.findings).toEqual([]);
  });

  it('flags rather than rejects a document read but not confirmed at source', async () => {
    const verifier = build(providerReturning({ sourceVerified: false, reason: 'UIDAI timeout' }));

    const result = await verifier.verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    expect(result.findings.map((f) => f.code)).toContain('NOT_CONFIRMED_WITH_ISSUER');
  });

  it('never rejects an applicant because the provider is down', async () => {
    // A vendor outage must not be indistinguishable from fraud.
    const provider: KycProvider = {
      name: 'test-provider',
      enabled: true,
      check: jest.fn().mockRejectedValue(new KycProviderUnavailableError('connect ETIMEDOUT')),
    };

    const result = await build(provider).verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    expect(result.findings.map((f) => f.code)).toContain('PROVIDER_UNAVAILABLE');
  });

  it('skips the provider entirely when none is configured', async () => {
    const provider: KycProvider = { name: 'none', enabled: false, check: jest.fn() };

    const result = await build(provider).verify(aadhaarUpload);

    expect(provider.check).not.toHaveBeenCalled();
    expect(result.verdict).toBe(DocumentCheckVerdict.PASSED);
  });

  it('does not send slots the provider cannot adjudicate', async () => {
    // A bank statement has no issuing authority to check against; sending it
    // would come back "unrecognised" and reject every legitimate upload.
    const provider = providerReturning({});

    const result = await build(provider).verify({
      ...aadhaarUpload,
      slot: RoleRequestDocumentSlot.BANK_DETAILS,
    });

    expect(provider.check).not.toHaveBeenCalled();
    expect(result.verdict).toBe(DocumentCheckVerdict.PASSED);
  });

  it('does not spend a provider call on a file that already failed integrity', async () => {
    const provider = providerReturning({});
    integrity.verify.mockResolvedValue({
      ...cleanIntegrity,
      verdict: DocumentCheckVerdict.FAILED,
      findings: [{ code: 'UNRECOGNISED_FORMAT', detail: 'not an image', severity: 'fatal' }],
    } satisfies DocumentCheckResult);

    const result = await build(provider).verify(aadhaarUpload);

    expect(provider.check).not.toHaveBeenCalled();
    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
  });

  it('keeps integrity warnings alongside a clean provider result', async () => {
    integrity.verify.mockResolvedValue({
      ...cleanIntegrity,
      verdict: DocumentCheckVerdict.SUSPECT,
      findings: [{ code: 'LOW_RESOLUTION', detail: '200x150 is too small', severity: 'warn' }],
    } satisfies DocumentCheckResult);

    const result = await build(providerReturning({})).verify(aadhaarUpload);

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    expect(result.findings.map((f) => f.code)).toContain('LOW_RESOLUTION');
  });
});
