import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/common/guards/jwt-auth.guard';
import {
  CurrentUser,
  RequirePermissions,
} from 'src/modules/authorization/decorators/authorization.decorators';
import { RbacPermissionsGuard } from 'src/modules/authorization/guards/rbac-permissions.guard';
import { GiftQueryDto } from '../dto/gift-catalog.dto';
import { GiftHistoryQueryDto } from '../dto/send-gift.dto';
import { GiftCatalogService } from '../services/gift-catalog.service';
import { GiftHistoryService } from '../services/gift-history.service';
import { GiftInventoryService } from '../services/gift-inventory.service';
import { GiftQueryService } from '../services/gift-query.service';

@ApiTags('Gifts & Enterprise Gift Engine')
@Controller('gifts')
export class GiftsController {
  constructor(
    private readonly catalogService: GiftCatalogService,
    private readonly historyService: GiftHistoryService,
    private readonly inventoryService: GiftInventoryService,
    private readonly queryService: GiftQueryService,
  ) {}

  // ---------------------------------------------------------
  // Public Catalog & Search APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'List active catalog gifts' })
  @ApiResponse({ status: 200, description: 'List of catalog gifts' })
  @Get('catalog')
  async listGifts(@Query() queryDto: GiftQueryDto) {
    return this.catalogService.listGifts(queryDto);
  }

  @ApiOperation({ summary: 'List gift categories' })
  @ApiResponse({ status: 200, description: 'List of gift categories' })
  @Get('categories')
  async listCategories() {
    return this.catalogService.listCategories();
  }

  @ApiOperation({ summary: 'Search catalog gifts by keyword or tag' })
  @ApiResponse({ status: 200, description: 'Matching gifts' })
  @Get('search')
  async searchGifts(@Query('q') query: string) {
    return this.queryService.searchGifts(query || '');
  }

  @ApiOperation({ summary: 'Get popular trending gifts' })
  @ApiResponse({ status: 200, description: 'Popular gifts list' })
  @Get('popular')
  async getPopularGifts(@Query('limit') limit = 10) {
    return this.queryService.getPopularGifts(Number(limit));
  }

  // ---------------------------------------------------------
  // Authenticated Gifting Transactions APIs
  // ---------------------------------------------------------

  @ApiOperation({ summary: 'Get user gift transaction history' })
  @ApiResponse({ status: 200, description: 'User gift history' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RbacPermissionsGuard)
  @RequirePermissions('gift.history.view')
  @Get('my-history')
  async getMyGiftHistory(
    @CurrentUser('id') userId: string,
    @Query() queryDto: GiftHistoryQueryDto,
  ) {
    return this.historyService.getUserGiftHistory(userId, queryDto);
  }

  @ApiOperation({ summary: 'Get current user backpack gift inventory' })
  @ApiResponse({ status: 200, description: 'Backpack inventory' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('inventory')
  async getMyInventory(@CurrentUser('id') userId: string) {
    return this.inventoryService.getUserInventory(userId);
  }

  @ApiOperation({ summary: 'Get gift transaction details' })
  @ApiResponse({ status: 200, description: 'Gift details' })
  @Get('catalog/:id')
  async getGiftById(@Param('id') id: string) {
    return this.catalogService.getGiftById(id);
  }
}
