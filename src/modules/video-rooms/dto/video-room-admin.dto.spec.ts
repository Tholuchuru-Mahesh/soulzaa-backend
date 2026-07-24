import { VideoRoomReportStatus, VideoRoomStatus } from '@prisma/client';
import { validate } from 'class-validator';
import {
  AdminListRoomsQueryDto,
  BanUserAdminDto,
  DisableChatAdminDto,
  LockRoomAdminDto,
  MuteUserAdminDto,
  RemoveParticipantAdminDto,
  ReviewReportAdminDto,
} from './video-room-admin.dto';

describe('VideoRoomAdminDto Validation', () => {
  it('should validate valid LockRoomAdminDto', async () => {
    const dto = new LockRoomAdminDto();
    dto.isLocked = true;
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should validate valid DisableChatAdminDto', async () => {
    const dto = new DisableChatAdminDto();
    dto.isChatDisabled = true;
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should validate valid RemoveParticipantAdminDto', async () => {
    const dto = new RemoveParticipantAdminDto();
    dto.targetUserId = '123e4567-e89b-12d3-a456-426614174000';
    dto.reason = 'Violation of rules';
    const errors = await validate(dto);
    expect(errors.length).toBe(0);
  });

  it('should validate valid BanUserAdminDto and MuteUserAdminDto', async () => {
    const ban = new BanUserAdminDto();
    ban.durationSeconds = 3600;
    ban.reason = 'Inappropriate content';
    expect((await validate(ban)).length).toBe(0);

    const mute = new MuteUserAdminDto();
    mute.durationSeconds = 1800;
    expect((await validate(mute)).length).toBe(0);
  });

  it('should validate ReviewReportAdminDto', async () => {
    const dto = new ReviewReportAdminDto();
    dto.status = VideoRoomReportStatus.REVIEWED;
    dto.note = 'Resolved with warning';
    expect((await validate(dto)).length).toBe(0);
  });

  it('should validate AdminListRoomsQueryDto', async () => {
    const query = new AdminListRoomsQueryDto();
    query.status = VideoRoomStatus.LIVE;
    query.search = 'Gaming';
    expect((await validate(query)).length).toBe(0);
  });
});
