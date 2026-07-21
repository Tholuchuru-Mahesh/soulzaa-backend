import { VideoRoomMemberRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { GrantVideoRoomRoleDto } from './grant-video-room-role.dto';
import {
  RemoveVideoRoomRoleDto,
  TransferVideoRoomOwnershipDto,
  UpdateVideoRoomRoleDto,
} from './video-room-role.dto';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('VR-7 role DTOs', () => {
  describe('RemoveVideoRoomRoleDto', () => {
    it('rejects a non-uuid userId', async () => {
      const dto = plainToInstance(RemoveVideoRoomRoleDto, { userId: 'nope' });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('accepts a uuid userId', async () => {
      const dto = plainToInstance(RemoveVideoRoomRoleDto, { userId: UUID });
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('UpdateVideoRoomRoleDto', () => {
    it('rejects OWNER — ownership is transferred, not assigned', async () => {
      const dto = plainToInstance(UpdateVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.OWNER,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    // VR-7 narrowed the grantable set: HOST comes from seat occupancy, so a
    // grantable HOST would create a second, conflicting source for the role.
    it('rejects HOST — it is seat-derived', async () => {
      const dto = plainToInstance(UpdateVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.HOST,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('accepts ADMIN with an ISO expiry', async () => {
      const dto = plainToInstance(UpdateVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: '2026-07-22T00:00:00.000Z',
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts MODERATOR without an expiry', async () => {
      const dto = plainToInstance(UpdateVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.MODERATOR,
      });
      expect(await validate(dto)).toHaveLength(0);
    });

    it('rejects a non-ISO expiry', async () => {
      const dto = plainToInstance(UpdateVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.ADMIN,
        expiresAt: 'next tuesday',
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });
  });

  describe('GrantVideoRoomRoleDto', () => {
    it('rejects HOST now that the grantable set is narrowed', async () => {
      const dto = plainToInstance(GrantVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.HOST,
      });
      expect(await validate(dto)).not.toHaveLength(0);
    });

    it('accepts ADMIN', async () => {
      const dto = plainToInstance(GrantVideoRoomRoleDto, {
        userId: UUID,
        role: VideoRoomMemberRole.ADMIN,
      });
      expect(await validate(dto)).toHaveLength(0);
    });
  });

  describe('TransferVideoRoomOwnershipDto', () => {
    it('requires a uuid newOwnerId', async () => {
      expect(
        await validate(plainToInstance(TransferVideoRoomOwnershipDto, { newOwnerId: 'x' })),
      ).not.toHaveLength(0);
      expect(
        await validate(plainToInstance(TransferVideoRoomOwnershipDto, { newOwnerId: UUID })),
      ).toHaveLength(0);
    });
  });
});
