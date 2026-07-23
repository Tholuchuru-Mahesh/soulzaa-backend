import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  AuditLogAction,
  CurrentUser,
  RequirePermissions,
  RequireRoles,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { RbacRolesGuard } from 'src/modules/authorization/guards/rbac-roles.guard';
import { AuditLogInterceptor } from 'src/modules/authorization/interceptors/audit-log.interceptor';
import {
  CreateGiftCategoryDto,
  CreateGiftDto,
  GiftQueryDto,
  UpdateGiftDto,
} from 'src/modules/gifts/dto/gift-catalog.dto';
import { GiftHistoryQueryDto } from 'src/modules/gifts/dto/send-gift.dto';
import { GiftAuditService } from 'src/modules/gifts/services/gift-audit.service';
import { GiftCatalogService } from 'src/modules/gifts/services/gift-catalog.service';
import { GiftHistoryService } from 'src/modules/gifts/services/gift-history.service';

@ApiTags('Super Admin - Enterprise Gift Engine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacRolesGuard, RbacPermissionsGuard)
@RequireRoles('SUPER_ADMIN')
@UseInterceptors(AuditLogInterceptor)
@Controller('super-admin/gifts')
export class SuperAdminGiftController {
  constructor(
    private readonly catalogService: GiftCatalogService,
    private readonly historyService: GiftHistoryService,
    private readonly auditService: GiftAuditService,
  ) {}

  // ---------------------------------------------------------
  // Gift Catalog & Category Management APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List all catalog gifts (Admin view)' })
  @ApiResponse({ status: 200, description: 'Catalog gifts list' })
  @RequirePermissions('gift.catalog.view')
  @Get('catalog')
  async listGifts(@Query() queryDto: GiftQueryDto) {
    return this.catalogService.listGifts(queryDto);
  }

  @ApiOperation({ summary: 'Create a new catalog gift' })
  @ApiResponse({ status: 201, description: 'Gift created successfully' })
  @RequirePermissions('gift.catalog.view')
  @AuditLogAction('GIFT_CREATED', 'gift')
  @Post('catalog')
  async createGift(@Body() dto: CreateGiftDto, @CurrentUser('id') actorId: string) {
    return this.catalogService.createGift(dto, actorId);
  }

  @ApiOperation({ summary: 'Update an existing catalog gift' })
  @ApiResponse({ status: 200, description: 'Gift updated successfully' })
  @RequirePermissions('gift.catalog.view')
  @AuditLogAction('GIFT_UPDATED', 'gift')
  @Put('catalog/:id')
  async updateGift(
    @Param('id') id: string,
    @Body() dto: UpdateGiftDto,
    @CurrentUser('id') actorId: string,
  ) {
    return this.catalogService.updateGift(id, dto, actorId);
  }

  @ApiOperation({ summary: 'Create a new gift category' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @RequirePermissions('gift.catalog.view')
  @Post('categories')
  async createCategory(@Body() dto: CreateGiftCategoryDto) {
    return this.catalogService.createCategory(dto);
  }

  // ---------------------------------------------------------
  // Gift Transactions & Audit APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'View gift transactions log for a context / room' })
  @ApiResponse({ status: 200, description: 'Room gift transactions' })
  @RequirePermissions('gift.history.view')
  @Get('transactions')
  async getRoomGiftHistory(
    @Query('contextId') contextId: string,
    @Query() queryDto: GiftHistoryQueryDto,
  ) {
    return this.historyService.getRoomGiftHistory(contextId || '', queryDto);
  }

  @ApiOperation({ summary: 'View gift operational audit log history' })
  @ApiResponse({ status: 200, description: 'Gift audit history' })
  @RequirePermissions('gift.audit.view')
  @Get('audit')
  async getGiftAuditHistory(@Query('giftId') giftId?: string) {
    return this.auditService.getGiftAuditHistory(giftId);
  }
}
