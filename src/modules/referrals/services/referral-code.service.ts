import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { ReferralConfigurationService } from './referral-configuration.service';
import { randomBytes } from 'crypto';


export interface GenerateCodeInput {
  referrerId: string;
  campaignId?: string;
  maxUses?: number;
  expiresAt?: Date;
}

@Injectable()
export class ReferralCodeService {
  private readonly logger = new Logger(ReferralCodeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ReferralConfigurationService,
  ) {}

  /** Generates a unique referral code string */
  private generateCodeString(): string {
    return randomBytes(6).toString('base64url').toUpperCase().slice(0, 10);
  }


  /** Creates a new referral code for the referrer */
  async createCode(input: GenerateCodeInput): Promise<unknown> {
    const defaultExpiryDays = await this.config.getDefaultExpiryDays();
    const defaultMaxUses = await this.config.getMaxUses();

    const expiresAt =
      input.expiresAt ??
      new Date(Date.now() + defaultExpiryDays * 24 * 60 * 60 * 1000);

    let code: string;
    let attempts = 0;
    do {
      code = this.generateCodeString();
      attempts++;
      if (attempts > 10)
        throw new Error('Could not generate unique referral code after 10 attempts.');
    } while (
      await this.prisma.referralCode.findUnique({ where: { code } })
    );

    const inviteLink = `https://soulzaa.app/invite/${code}`;
    const qrCodeUrl = `https://soulzaa.app/qr/${code}`;

    const record = await this.prisma.referralCode.create({
      data: {
        code,
        referrerId: input.referrerId,
        campaignId: input.campaignId ?? null,
        inviteLink,
        qrCodeUrl,
        maxUses: input.maxUses ?? defaultMaxUses,
        expiresAt,
      },
    });

    this.logger.log(`Code created: ${code} for referrer: ${input.referrerId}`);
    return record;
  }

  async findByCode(code: string): Promise<unknown> {
    return this.prisma.referralCode.findUnique({ where: { code } });
  }

  async findByReferrer(referrerId: string): Promise<unknown[]> {
    return this.prisma.referralCode.findMany({
      where: { referrerId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async incrementUses(referralCodeId: string): Promise<void> {
    await this.prisma.referralCode.update({
      where: { id: referralCodeId },
      data: { usesCount: { increment: 1 } },
    });
  }

  async expireStale(): Promise<number> {
    const result = await this.prisma.referralCode.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    });
    return result.count;
  }
}
