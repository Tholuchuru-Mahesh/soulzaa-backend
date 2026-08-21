import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { InventoryRecipientType } from '@prisma/client';
import { CurrentUser } from 'src/common/decorators/current-user.decorator';
import { RequirePermissions } from 'src/common/decorators/require-permissions.decorator';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { DistributeInventoryDto, CreateInventoryItemDto } from '../dto/official-inventory.dto';
import { OfficialInventoryService } from '../services/official-inventory.service';

@ApiTags('Official — Inventory')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RbacPermissionsGuard)
@RequirePermissions('mobile.workforce.view')
@Controller('mobile/official-inventory')
export class OfficialInventoryController {
  constructor(private readonly service: OfficialInventoryService) {}

  @ApiOperation({ summary: 'List inventory items and metric cards (Official / Superadmin)' })
  @ApiQuery({ name: 'category', required: false, description: 'Category filter (ALL, GIFTS, FRAMES, ENTRY_EFFECTS, THEMES, REWARDS, BADGES)' })
  @ApiQuery({ name: 'search', required: false, description: 'Search items by name, event, source' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Inventory items and metrics' })
  @Get()
  getInventory(
    @CurrentUser() user: any,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    const isSuperAdminOrAdmin = user?.roles?.some((r: string) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
    const officialId = isSuperAdminOrAdmin ? undefined : user?.id;
    return this.service.getInventory(officialId, { category, search, limit, offset });
  }

  @ApiOperation({ summary: 'Search recipients for distribution (Agency / Creator / User)' })
  @ApiQuery({ name: 'type', required: true, enum: ['AGENCY', 'CREATOR', 'USER'] })
  @ApiQuery({ name: 'query', required: false })
  @ApiResponse({ status: 200, description: 'List of matching recipients' })
  @Get('recipients')
  getRecipients(
    @CurrentUser('id') officialId: string,
    @Query('type') type: InventoryRecipientType,
    @Query('query') query?: string,
  ) {
    return this.service.getRecipients(officialId, type, query);
  }

  @ApiOperation({ summary: 'Get distribution transaction history' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'offset', required: false })
  @ApiResponse({ status: 200, description: 'Transaction history' })
  @Get('transactions')
  getTransactions(
    @CurrentUser() user: any,
    @Query('limit', new DefaultValuePipe(50), ParseIntPipe) limit?: number,
    @Query('offset', new DefaultValuePipe(0), ParseIntPipe) offset?: number,
  ) {
    const isSuperAdminOrAdmin = user?.roles?.some((r: string) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
    const officialId = isSuperAdminOrAdmin ? undefined : user?.id;
    return this.service.getTransactions(officialId, limit, offset);
  }

  @ApiOperation({ summary: 'Get single inventory item details by ID' })
  @ApiResponse({ status: 200, description: 'Item details' })
  @Get(':id')
  getItemById(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const isSuperAdminOrAdmin = user?.roles?.some((r: string) => ['SUPER_ADMIN', 'ADMIN'].includes(r));
    const officialId = isSuperAdminOrAdmin ? undefined : user?.id;
    return this.service.getItemById(officialId, id);
  }

  @ApiOperation({ summary: 'List officials for asset allocation (Superadmin / Admin)' })
  @ApiResponse({ status: 200, description: 'List of officials' })
  @Get('officials')
  getOfficials() {
    return this.service.getOfficials();
  }

  @ApiOperation({ summary: 'Grant / allocate inventory stock to an Official (Superadmin / Admin)' })
  @ApiResponse({ status: 201, description: 'Asset stock granted successfully' })
  @Post('grant')
  grantInventoryItem(@Body() dto: CreateInventoryItemDto) {
    return this.service.grantInventoryItem(dto);
  }

  @ApiOperation({ summary: 'Distribute asset to an Agency, Creator, or User' })
  @ApiResponse({ status: 201, description: 'Asset distributed successfully' })
  @Post('distribute')
  distribute(
    @CurrentUser('id') officialId: string,
    @Body() dto: DistributeInventoryDto,
  ) {
    return this.service.distribute(officialId, dto);
  }
}
