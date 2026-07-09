import {
  Body,
  Controller,
  Delete,
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
import { BlockedWordDto, ListBlockedWordsDto, UpdateBlockedWordDto } from '../dto/chat.dto';
import { ChatService } from '../services/chat.service';

/**
 * Platform-admin CRUD for the AR-4 severity-based blocked-word dictionary
 * (base `admin/chat/blocked-words`). Restricted to platform ADMIN/SUPER_ADMIN.
 * Every mutation invalidates the in-memory engine cache so filtering reflects
 * the change immediately.
 */
@ApiTags('audio-room-chat-admin')
@ApiBearerAuth()
@Roles('ADMIN', 'SUPER_ADMIN')
@Controller('admin/chat/blocked-words')
export class ChatAdminController {
  constructor(private readonly chat: ChatService) {}

  @Get()
  @ApiOperation({ summary: 'List blocked-word dictionary entries' })
  list(@Query() q: ListBlockedWordsDto) {
    return this.chat.listWords(q);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a blocked-word entry' })
  create(@CurrentUser('id') actorId: string, @Body() dto: BlockedWordDto) {
    return this.chat.createWord(actorId, dto);
  }

  @Patch(':wordId')
  @ApiOperation({ summary: 'Update a blocked-word entry' })
  update(
    @CurrentUser('id') actorId: string,
    @Param('wordId', ParseUuidPipe) wordId: string,
    @Body() dto: UpdateBlockedWordDto,
  ) {
    return this.chat.updateWord(actorId, wordId, dto);
  }

  @Delete(':wordId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a blocked-word entry' })
  async remove(@Param('wordId', ParseUuidPipe) wordId: string) {
    await this.chat.deleteWord(wordId);
    return { deleted: true };
  }
}
