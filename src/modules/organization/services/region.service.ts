import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Region } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateRegionDto, UpdateRegionDto } from '../dto/region.dto';

@Injectable()
export class RegionService {
  constructor(private readonly prisma: PrismaService) {}

  async createRegion(dto: CreateRegionDto): Promise<Region> {
    const state = await this.prisma.state.findUnique({
      where: { id: dto.stateId },
      include: { country: true },
    });
    if (!state) {
      throw new NotFoundException(`Parent State with ID '${dto.stateId}' not found`);
    }

    if (!state.isActive) {
      throw new BadRequestException(`Cannot create region under inactive state '${state.name}'`);
    }

    if (!state.country.isActive) {
      throw new BadRequestException(
        `Cannot create region under inactive country '${state.country.name}'`,
      );
    }

    const codeUpper = dto.code.trim().toUpperCase();

    const existingCode = await this.prisma.region.findUnique({
      where: {
        stateId_code: {
          stateId: dto.stateId,
          code: codeUpper,
        },
      },
    });
    if (existingCode) {
      throw new ConflictException(
        `Region with code '${codeUpper}' already exists under state '${state.name}'`,
      );
    }

    const existingName = await this.prisma.region.findFirst({
      where: {
        stateId: dto.stateId,
        name: { equals: dto.name.trim(), mode: 'insensitive' },
      },
    });
    if (existingName) {
      throw new ConflictException(
        `Region with name '${dto.name}' already exists under state '${state.name}'`,
      );
    }

    return this.prisma.region.create({
      data: {
        stateId: dto.stateId,
        code: codeUpper,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        isActive: dto.isActive ?? true,
      },
    });
  }

  async getAllRegions(stateId?: string, activeOnly?: boolean): Promise<Region[]> {
    const where: any = {};
    if (stateId) where.stateId = stateId;
    if (activeOnly) where.isActive = true;

    return this.prisma.region.findMany({
      where,
      include: {
        state: {
          include: { country: true },
        },
      },
      orderBy: { name: 'asc' },
    });
  }

  async getRegionById(id: string): Promise<Region> {
    const region = await this.prisma.region.findUnique({
      where: { id },
      include: {
        state: {
          include: { country: true },
        },
      },
    });
    if (!region) {
      throw new NotFoundException(`Region with ID '${id}' not found`);
    }
    return region;
  }

  async updateRegion(id: string, dto: UpdateRegionDto): Promise<Region> {
    const region = await this.getRegionById(id);

    if (dto.name) {
      const existingName = await this.prisma.region.findFirst({
        where: {
          id: { not: id },
          stateId: region.stateId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
      if (existingName) {
        throw new ConflictException(
          `Region with name '${dto.name}' already exists under this state`,
        );
      }
    }

    return this.prisma.region.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? dto.description.trim() : undefined,
      },
    });
  }

  async setRegionStatus(id: string, isActive: boolean): Promise<Region> {
    await this.getRegionById(id);

    return this.prisma.region.update({
      where: { id },
      data: { isActive },
    });
  }
}
