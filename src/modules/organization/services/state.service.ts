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

    return this.prisma.state.create({
      data: {
        countryId: dto.countryId,
        code: codeUpper,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        isActive: dto.isActive ?? true,
      },
    });
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
