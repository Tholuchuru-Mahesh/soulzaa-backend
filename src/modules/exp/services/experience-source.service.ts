import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';

export interface CreateExperienceSourceInput {
  code: string;
  name: string;
  baseExp?: number;
  dailyCap?: number;
}

@Injectable()
export class ExperienceSourceService {
  constructor(private readonly prisma: PrismaService) {}

  async findByCode(code: string) {
    return this.prisma.experienceSource.findUnique({
      where: { code },
    });
  }

  async getActiveSources() {
    return this.prisma.experienceSource.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { code: 'asc' },
    });
  }

  async createSource(input: CreateExperienceSourceInput) {
    return this.prisma.experienceSource.upsert({
      where: { code: input.code },
      update: {
        name: input.name,
        baseExp: input.baseExp ?? 10,
        dailyCap: input.dailyCap ?? 0,
        status: 'ACTIVE',
      },
      create: {
        code: input.code,
        name: input.name,
        baseExp: input.baseExp ?? 10,
        dailyCap: input.dailyCap ?? 0,
        status: 'ACTIVE',
      },
    });
  }

  async updateSource(code: string, updates: Partial<CreateExperienceSourceInput>) {
    const existing = await this.findByCode(code);
    if (!existing) {
      throw new NotFoundException(`Experience source ${code} not found.`);
    }

    return this.prisma.experienceSource.update({
      where: { code },
      data: updates,
    });
  }
}
