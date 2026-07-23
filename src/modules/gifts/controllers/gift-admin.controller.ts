import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { ParseUuidPipe } from 'src/common/pipes/parse-uuid.pipe';
import { CreateGiftDto, GiftQueryDto, UpdateGiftDto } from '../dto/gift-catalog.dto';
import { GiftCatalogService } from '../services/gift-catalog.service';

/**
 * Platform-admin gift catalog CRUD (base `admin/gifts`). Restricted to
 * ADMIN/SUPER_ADMIN. Gifts are disabled via `enabled=false` rather than deleted
 * so the immutable gift ledger keeps referencing a valid catalog id.
 */
@ApiTags('gifts-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/gifts')
export class GiftAdminController {
  constructor(private readonly catalog: GiftCatalogService) {}

  @Get()
  @ApiOperation({ summary: 'List catalog gifts (paginated)' })
  list(@Query() q: GiftQueryDto) {
    return this.catalog.listGifts(q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a catalog gift' })
  create(@CurrentUser('id') adminId: string, @Body() dto: CreateGiftDto) {
    return this.catalog.createGift(dto, adminId);
  }

  @Patch(':giftId')
  @ApiOperation({ summary: 'Update a catalog gift' })
  update(
    @CurrentUser('id') adminId: string,
    @Param('giftId', ParseUuidPipe) giftId: string,
    @Body() dto: UpdateGiftDto,
  ) {
    return this.catalog.updateGift(giftId, dto, adminId);
  }
}
