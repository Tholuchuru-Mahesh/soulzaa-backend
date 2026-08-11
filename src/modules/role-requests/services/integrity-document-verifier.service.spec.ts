import { DocumentCheckVerdict, RoleRequestDocumentSlot } from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { S3Service } from 'src/infra/storage/s3.service';
import { IntegrityDocumentVerifier } from './integrity-document-verifier.service';

/**
 * A JPEG of random noise, large enough to clear the "implausibly small" floor
 * and detailed enough to clear the resolution floor — i.e. what a real scan
 * looks like to the checks.
 */
async function realisticJpeg(width = 600, height = 400): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('IntegrityDocumentVerifier', () => {
  let verifier: IntegrityDocumentVerifier;

  const s3 = { getObjectBuffer: jest.fn() };
  const prisma = { roleRequestDocument: { findMany: jest.fn() } };

  const subject = {
    slot: RoleRequestDocumentSlot.AADHAAR,
    storageKey: 'kyc-documents/user-1/doc.jpg',
    declaredContentType: 'image/jpeg',
    subjectUserId: 'user-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.roleRequestDocument.findMany.mockResolvedValue([]);
    verifier = new IntegrityDocumentVerifier(
      s3 as unknown as S3Service,
      prisma as unknown as PrismaService,
    );
  });

  it('passes a well-formed, unseen JPEG', async () => {
    s3.getObjectBuffer.mockResolvedValue(await realisticJpeg());

    const result = await verifier.verify(subject);

    expect(result.verdict).toBe(DocumentCheckVerdict.PASSED);
    expect(result.findings).toEqual([]);
    expect(result.detectedContentType).toBe('image/jpeg');
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails a file whose bytes are not the type it was uploaded as', async () => {
    // The case that matters: an executable renamed to .jpg and declared as one.
    s3.getObjectBuffer.mockResolvedValue(Buffer.from('MZ\x90\x00executable payload'.repeat(2000)));

    const result = await verifier.verify(subject);

    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
    expect(result.findings.map((f) => f.code)).toContain('UNRECOGNISED_FORMAT');
  });

  it('fails a real PNG that claims to be a JPEG', async () => {
    const png = await sharp({
      create: { width: 600, height: 400, channels: 3, background: '#4488cc' },
    })
      .png()
      .toBuffer();
    s3.getObjectBuffer.mockResolvedValue(png);

    const result = await verifier.verify(subject);

    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
    expect(result.findings.map((f) => f.code)).toContain('CONTENT_TYPE_MISMATCH');
  });

  it('flags an image too low-resolution to read', async () => {
    s3.getObjectBuffer.mockResolvedValue(await realisticJpeg(120, 90));

    const result = await verifier.verify(subject);

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    expect(result.findings.map((f) => f.code)).toContain('LOW_RESOLUTION');
  });

  it('flags the same bytes submitted by a different applicant', async () => {
    s3.getObjectBuffer.mockResolvedValue(await realisticJpeg());
    prisma.roleRequestDocument.findMany.mockResolvedValue([
      { request: { reference: 'RR-2026-000042' } },
    ]);

    const result = await verifier.verify(subject);

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    const duplicate = result.findings.find((f) => f.code === 'DUPLICATE_ACROSS_APPLICANTS');
    expect(duplicate?.detail).toContain('RR-2026-000042');
  });

  it('does not flag one applicant reusing a scan across two of their own slots', async () => {
    s3.getObjectBuffer.mockResolvedValue(await realisticJpeg());

    await verifier.verify(subject);

    // The query itself must exclude the applicant — otherwise a bank statement
    // doubling as address proof would warn on every submission and train
    // reviewers to ignore the flag.
    expect(prisma.roleRequestDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          request: { subjectUserId: { not: 'user-1' } },
        }),
      }),
    );
  });

  it('fails a truncated PDF', async () => {
    s3.getObjectBuffer.mockResolvedValue(
      Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(20_000, 0x41)]),
    );

    const result = await verifier.verify({ ...subject, declaredContentType: 'application/pdf' });

    expect(result.verdict).toBe(DocumentCheckVerdict.FAILED);
    expect(result.findings.map((f) => f.code)).toContain('MALFORMED_PDF');
  });

  it('warns on a password-protected PDF a reviewer could not open', async () => {
    const pdf = Buffer.from(
      `%PDF-1.7\n/Type /Page \n/Encrypt 4 0 R\n${'x'.repeat(20_000)}\ntrailer\n%%EOF`,
    );
    s3.getObjectBuffer.mockResolvedValue(pdf);

    const result = await verifier.verify({ ...subject, declaredContentType: 'application/pdf' });

    expect(result.verdict).toBe(DocumentCheckVerdict.SUSPECT);
    expect(result.findings.map((f) => f.code)).toContain('ENCRYPTED_PDF');
  });

  it('warns when image metadata names an editor', async () => {
    const jpeg = await sharp(
      Buffer.alloc(600 * 400 * 3).map((_, i) => (i * 7919) % 256) as unknown as Buffer,
      { raw: { width: 600, height: 400, channels: 3 } },
    )
      .withMetadata({ exif: { IFD0: { Software: 'Adobe Photoshop 2026' } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    s3.getObjectBuffer.mockResolvedValue(jpeg);

    const result = await verifier.verify(subject);

    expect(result.findings.map((f) => f.code)).toContain('EDITED_WITH_IMAGE_EDITOR');
  });
});
