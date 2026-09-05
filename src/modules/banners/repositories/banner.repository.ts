import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/infra/prisma/prisma.service';
import { CreateBannerDto, UpdateBannerDto } from '../dto/banner.dto';

@Injectable()
export class BannerRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: CreateBannerDto & { createdBy?: string }) {
    return this.prisma.homeBanner.create({ data });
  }

  update(id: string, data: UpdateBannerDto) {
    return this.prisma.homeBanner.update({ where: { id }, data });
  }

  findById(id: string) {
    return this.prisma.homeBanner.findUnique({ where: { id } });
  }

  list() {
    return this.prisma.homeBanner.findMany({ orderBy: { sortOrder: 'asc' } });
  }

  listActive() {
    return this.prisma.homeBanner.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  }

  toggle(id: string, isActive: boolean) {
    return this.prisma.homeBanner.update({ where: { id }, data: { isActive } });
  }

  remove(id: string) {
    return this.prisma.homeBanner.delete({ where: { id } });
  }

  async reorder(orderedIds: string[]) {
    await this.prisma.$transaction(
      orderedIds.map((id, index) =>
        this.prisma.homeBanner.update({ where: { id }, data: { sortOrder: index } }),
      ),
    );
  }
}
