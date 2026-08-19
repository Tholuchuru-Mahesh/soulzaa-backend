import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { State } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateStateDto, UpdateStateDto } from '../dto/state.dto';

@Injectable()
export class StateService {
  constructor(private readonly prisma: PrismaService) {}

  async createState(dto: CreateStateDto): Promise<State> {
    const country = await this.prisma.country.findUnique({
      where: { id: dto.countryId },
    });
    if (!country) {
      throw new NotFoundException(`Parent Country with ID '${dto.countryId}' not found`);
    }

    if (!country.isActive) {
      throw new BadRequestException(`Cannot create state under inactive country '${country.name}'`);
    }

    const codeUpper = dto.code.trim().toUpperCase();

    const existingCode = await this.prisma.state.findUnique({
      where: {
        countryId_code: {
          countryId: dto.countryId,
          code: codeUpper,
        },
      },
    });
    if (existingCode) {
      throw new ConflictException(
        `State with code '${codeUpper}' already exists under country '${country.name}'`,
      );
    }

    const existingName = await this.prisma.state.findFirst({
      where: {
        countryId: dto.countryId,
        name: { equals: dto.name.trim(), mode: 'insensitive' },
      },
    });
    if (existingName) {
      throw new ConflictException(
        `State with name '${dto.name}' already exists under country '${country.name}'`,
      );
    }

    const moderatorRegionCode = await this.generateModeratorRegionCode(dto.countryId, country.code);

    return this.prisma.state.create({
      data: {
        countryId: dto.countryId,
        code: codeUpper,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        isActive: dto.isActive ?? true,
        moderatorRegionCode,
      },
    });
  }

  /**
   * System-generated `{countryCode}-S-{sequence}` id shown to Moderators as
   * their "Region ID" (see `State.moderatorRegionCode`) — never admin-typed,
   * so it can't collide or be mistyped the way the freeform `code` field can.
   * Sequence is per-country, in creation order; the retry loop only matters
   * if an earlier slot was somehow already taken (e.g. manual DB edits).
   */
  private async generateModeratorRegionCode(
    countryId: string,
    countryCode: string,
  ): Promise<string> {
    const existingCount = await this.prisma.state.count({ where: { countryId } });
    for (let offset = 0; offset < 5; offset++) {
      const seq = String(existingCount + 1 + offset).padStart(2, '0');
      const candidate = `${countryCode}-S-${seq}`;
      const clash = await this.prisma.state.findUnique({
        where: { moderatorRegionCode: candidate },
      });
      if (!clash) return candidate;
    }
    return `${countryCode}-S-${Date.now().toString(36).toUpperCase()}`;
  }

  async getAllStates(countryId?: string, activeOnly?: boolean): Promise<State[]> {
    const where: any = {};
    if (countryId) where.countryId = countryId;
    if (activeOnly) where.isActive = true;

    return this.prisma.state.findMany({
      where,
      include: { country: true },
      orderBy: { name: 'asc' },
    });
  }

  async getStateById(id: string): Promise<State> {
    const state = await this.prisma.state.findUnique({
      where: { id },
      include: { country: true },
    });
    if (!state) {
      throw new NotFoundException(`State with ID '${id}' not found`);
    }
    return state;
  }

  async updateState(id: string, dto: UpdateStateDto): Promise<State> {
    const state = await this.getStateById(id);

    if (dto.name) {
      const existingName = await this.prisma.state.findFirst({
        where: {
          id: { not: id },
          countryId: state.countryId,
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
      if (existingName) {
        throw new ConflictException(
          `State with name '${dto.name}' already exists under this country`,
        );
      }
    }

    return this.prisma.state.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? dto.description.trim() : undefined,
      },
    });
  }

  async setStateStatus(id: string, isActive: boolean): Promise<State> {
    await this.getStateById(id);

    return this.prisma.state.update({
      where: { id },
      data: { isActive },
    });
  }
}
