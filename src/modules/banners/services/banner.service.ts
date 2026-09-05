import { Injectable } from '@nestjs/common';
import { BannerRepository } from '../repositories/banner.repository';
import { CreateBannerDto, UpdateBannerDto } from '../dto/banner.dto';
import { MediaUrlResolver } from 'src/infra/storage/media-url.resolver';

@Injectable()
export class BannerService {
  constructor(
    private readonly repo: BannerRepository,
    private readonly media: MediaUrlResolver,
  ) {}

  list() {
    return this.repo.list();
  }

  create(actorId: string, dto: CreateBannerDto) {
    return this.repo.create({ ...dto, createdBy: actorId });
  }

  update(id: string, dto: UpdateBannerDto) {
    return this.repo.update(id, dto);
  }

  toggle(id: string, isActive: boolean) {
    return this.repo.toggle(id, isActive);
  }

  remove(id: string) {
    return this.repo.remove(id);
  }

  reorder(orderedIds: string[]) {
    return this.repo.reorder(orderedIds);
  }

  async listActiveForApp() {
    const banners = await this.repo.listActive();
    return Promise.all(
      banners.map(async (b) => ({
        id: b.id,
        title: b.title,
        imageUrl: await this.media.resolve(b.imageKey),
        mediaType: b.mediaType,
        focalX: b.focalX,
        focalY: b.focalY,
        redirectPage: b.redirectPage,
        redirectTargetId: b.redirectTargetId,
        externalUrl: b.externalUrl,
        sortOrder: b.sortOrder,
      })),
    );
  }
}
