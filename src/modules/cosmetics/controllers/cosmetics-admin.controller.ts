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
import { CosmeticDto, ListCosmeticsDto, UpdateCosmeticDto } from '../dto/cosmetics.dto';
import { CosmeticsService } from '../services/cosmetics.service';

/**
 * Platform-admin cosmetics catalog CRUD (base `admin/cosmetics`). Restricted to
 * ADMIN/SUPER_ADMIN. Cosmetics are disabled via `enabled=false` rather than
 * deleted so granted backpack items keep referencing a valid catalog id.
 */
@ApiTags('cosmetics-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/cosmetics')
export class CosmeticsAdminController {
  constructor(private readonly cosmetics: CosmeticsService) {}

  @Get()
  @ApiOperation({ summary: 'List catalog cosmetics (paginated)' })
  list(@Query() q: ListCosmeticsDto) {
    return this.cosmetics.list(q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a cosmetic' })
  create(@CurrentUser('id') adminId: string, @Body() dto: CosmeticDto) {
    return this.cosmetics.create(adminId, dto);
  }

  @Patch(':cosmeticId')
  @ApiOperation({ summary: 'Update a cosmetic' })
  update(
    @CurrentUser('id') adminId: string,
    @Param('cosmeticId', ParseUuidPipe) cosmeticId: string,
    @Body() dto: UpdateCosmeticDto,
  ) {
    return this.cosmetics.update(adminId, cosmeticId, dto);
  }
}
