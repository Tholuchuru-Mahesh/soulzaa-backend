import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { ExperienceSourceService } from './experience-source.service';
import { LevelConfigurationService } from './level-configuration.service';

@Injectable()
export class LevelValidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sourceService: ExperienceSourceService,
    private readonly configService: LevelConfigurationService,
  ) {}

  async validateUserExists(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found.`);
    }
  }

  async validateSourceExists(sourceCode: string): Promise<void> {
    const source = await this.sourceService.findByCode(sourceCode);
    if (!source || source.status !== 'ACTIVE') {
      throw new BadRequestException(`Invalid or inactive EXP source code: ${sourceCode}`);
    }
  }

  validateExpAmount(amount: number): void {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new BadRequestException(`EXP amount must be a positive integer.`);
    }
  }

  async checkIdempotency(idempotencyKey: string): Promise<boolean> {
    const existing = await this.prisma.experienceHistory.findUnique({
      where: { idempotencyKey },
    });
    return !!existing;
  }

  async validateLimits(userId: string, amount: number): Promise<void> {
    const params = await this.configService.getParameters();
    const userLevel = await this.prisma.userLevel.findUnique({
      where: { userId },
    });

    if (userLevel) {
      if (Number(userLevel.dailyExp) + amount > params.dailyExpLimit) {
        throw new BadRequestException(`Daily EXP limit (${params.dailyExpLimit}) exceeded.`);
      }
    }
  }
}
