import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Country } from '@prisma/client';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateCountryDto, UpdateCountryDto } from '../dto/country.dto';

@Injectable()
export class CountryService {
  constructor(private readonly prisma: PrismaService) {}

  async createCountry(dto: CreateCountryDto): Promise<Country> {
    const codeUpper = dto.code.trim().toUpperCase();

    const existingCode = await this.prisma.country.findUnique({
      where: { code: codeUpper },
    });
    if (existingCode) {
      throw new ConflictException(`Country with ISO code '${codeUpper}' already exists`);
    }

    const existingName = await this.prisma.country.findFirst({
      where: { name: { equals: dto.name.trim(), mode: 'insensitive' } },
    });
    if (existingName) {
      throw new ConflictException(`Country with name '${dto.name}' already exists`);
    }

    return this.prisma.country.create({
      data: {
        code: codeUpper,
        name: dto.name.trim(),
        description: dto.description?.trim(),
        isActive: dto.isActive ?? true,
      },
    });
  }

  async getAllCountries(activeOnly?: boolean): Promise<Country[]> {
    const where = activeOnly ? { isActive: true } : {};
    return this.prisma.country.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  async getCountryById(id: string): Promise<Country> {
    const country = await this.prisma.country.findUnique({ where: { id } });
    if (!country) {
      throw new NotFoundException(`Country with ID '${id}' not found`);
    }
    return country;
  }

  async updateCountry(id: string, dto: UpdateCountryDto): Promise<Country> {
    await this.getCountryById(id);

    if (dto.name) {
      const existingName = await this.prisma.country.findFirst({
        where: {
          id: { not: id },
          name: { equals: dto.name.trim(), mode: 'insensitive' },
        },
      });
      if (existingName) {
        throw new ConflictException(`Country with name '${dto.name}' already exists`);
      }
    }

    return this.prisma.country.update({
      where: { id },
      data: {
        name: dto.name ? dto.name.trim() : undefined,
        description: dto.description !== undefined ? dto.description.trim() : undefined,
      },
    });
  }

  async setCountryStatus(id: string, isActive: boolean): Promise<Country> {
    await this.getCountryById(id);

    return this.prisma.country.update({
      where: { id },
      data: { isActive },
    });
  }
}
