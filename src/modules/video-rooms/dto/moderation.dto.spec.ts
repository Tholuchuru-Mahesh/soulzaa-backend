import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  VideoRoomModerationMuteType,
  VideoRoomReportReason,
  VideoRoomReportStatus,
} from '@prisma/client';
import { VIDEO_ROOM_MODERATION_REASON_MAX } from '../constants/video-room.constants';
import { VIDEO_ROOM_MODERATION_DESCRIPTION_MAX } from '../constants/video-room-moderation.constants';
import {
  BlockVideoRoomUserDto,
  ForceDisconnectDto,
  KickVideoRoomUsersDto,
  ListModerationDto,
  MuteAllDto,
  MuteVideoRoomUserDto,
  ReportVideoRoomUserDto,
  ReviewReportDto,
  UnmuteVideoRoomUserDto,
  WarnVideoRoomUserDto,
} from './moderation.dto';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-9222-222222222222';

const build = <T extends object>(cls: new () => T, raw: Record<string, unknown>) =>
  validate(plainToInstance(cls, raw));

describe('MuteVideoRoomUserDto', () => {
  it('accepts the existing shape unchanged (backward compatible)', async () => {
    const errors = await build(MuteVideoRoomUserDto, {
      userId: UUID_A,
      type: VideoRoomModerationMuteType.PERMANENT,
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts the additive optional channels field', async () => {
    const errors = await build(MuteVideoRoomUserDto, {
      userId: UUID_A,
      type: VideoRoomModerationMuteType.PERMANENT,
      channels: ['chat'],
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an unknown channel value', async () => {
    const errors = await build(MuteVideoRoomUserDto, {
      userId: UUID_A,
      type: VideoRoomModerationMuteType.PERMANENT,
      channels: ['video'],
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an empty channels array', async () => {
    const errors = await build(MuteVideoRoomUserDto, {
      userId: UUID_A,
      type: VideoRoomModerationMuteType.PERMANENT,
      channels: [],
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('BlockVideoRoomUserDto', () => {
  it('remains unchanged and valid', async () => {
    const errors = await build(BlockVideoRoomUserDto, { userId: UUID_A });
    expect(errors).toHaveLength(0);
  });
});

describe('KickVideoRoomUsersDto', () => {
  const valid = { userIds: [UUID_A, UUID_B] };

  it('accepts a well-formed payload', async () => {
    expect(await build(KickVideoRoomUsersDto, valid)).toHaveLength(0);
  });

  it('accepts an optional reason within bounds', async () => {
    expect(await build(KickVideoRoomUsersDto, { ...valid, reason: 'spamming' })).toHaveLength(0);
  });

  it('rejects an empty userIds array', async () => {
    const errors = await build(KickVideoRoomUsersDto, { userIds: [] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-uuid entry in userIds', async () => {
    const errors = await build(KickVideoRoomUsersDto, { userIds: ['nope'] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a reason over the max length', async () => {
    const errors = await build(KickVideoRoomUsersDto, {
      ...valid,
      reason: 'a'.repeat(VIDEO_ROOM_MODERATION_REASON_MAX + 1),
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('UnmuteVideoRoomUserDto', () => {
  it('accepts userId alone', async () => {
    expect(await build(UnmuteVideoRoomUserDto, { userId: UUID_A })).toHaveLength(0);
  });

  it('accepts userId with channels', async () => {
    expect(
      await build(UnmuteVideoRoomUserDto, { userId: UUID_A, channels: ['chat', 'mic'] }),
    ).toHaveLength(0);
  });

  it('rejects a missing userId', async () => {
    const errors = await build(UnmuteVideoRoomUserDto, { channels: ['chat'] });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects an invalid channel', async () => {
    const errors = await build(UnmuteVideoRoomUserDto, { userId: UUID_A, channels: ['bogus'] });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('MuteAllDto', () => {
  it('accepts an empty payload (channels optional)', async () => {
    expect(await build(MuteAllDto, {})).toHaveLength(0);
  });

  it('accepts a valid channels list', async () => {
    expect(await build(MuteAllDto, { channels: ['mic'] })).toHaveLength(0);
  });

  it('rejects an invalid channel', async () => {
    const errors = await build(MuteAllDto, { channels: ['nope'] });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('WarnVideoRoomUserDto', () => {
  const valid = { userId: UUID_A, reason: 'abusive language' };

  it('accepts a well-formed payload', async () => {
    expect(await build(WarnVideoRoomUserDto, valid)).toHaveLength(0);
  });

  it('accepts optional structured metadata', async () => {
    expect(
      await build(WarnVideoRoomUserDto, { ...valid, metadata: { messageId: UUID_B } }),
    ).toHaveLength(0);
  });

  it('rejects a missing reason', async () => {
    const errors = await build(WarnVideoRoomUserDto, { userId: UUID_A });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a reason over the max length', async () => {
    const errors = await build(WarnVideoRoomUserDto, {
      ...valid,
      reason: 'a'.repeat(VIDEO_ROOM_MODERATION_REASON_MAX + 1),
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ForceDisconnectDto', () => {
  it('accepts userId alone', async () => {
    expect(await build(ForceDisconnectDto, { userId: UUID_A })).toHaveLength(0);
  });

  it('accepts an optional reason', async () => {
    expect(await build(ForceDisconnectDto, { userId: UUID_A, reason: 'AFK abuse' })).toHaveLength(
      0,
    );
  });

  it('rejects a missing userId', async () => {
    const errors = await build(ForceDisconnectDto, {});
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ReportVideoRoomUserDto', () => {
  const valid = { targetUserId: UUID_A, reason: VideoRoomReportReason.SPAM };

  it('accepts a well-formed payload', async () => {
    expect(await build(ReportVideoRoomUserDto, valid)).toHaveLength(0);
  });

  it('accepts optional description and messageId', async () => {
    expect(
      await build(ReportVideoRoomUserDto, {
        ...valid,
        description: 'kept spamming links',
        messageId: UUID_B,
      }),
    ).toHaveLength(0);
  });

  it('rejects an invalid reason enum value', async () => {
    const errors = await build(ReportVideoRoomUserDto, { ...valid, reason: 'NONSENSE' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a description over the max length', async () => {
    const errors = await build(ReportVideoRoomUserDto, {
      ...valid,
      description: 'a'.repeat(VIDEO_ROOM_MODERATION_DESCRIPTION_MAX + 1),
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ReviewReportDto', () => {
  it('accepts a well-formed payload', async () => {
    expect(await build(ReviewReportDto, { status: VideoRoomReportStatus.REVIEWED })).toHaveLength(
      0,
    );
  });

  it('accepts an optional resolutionAction', async () => {
    expect(
      await build(ReviewReportDto, {
        status: VideoRoomReportStatus.ACTIONED,
        resolutionAction: 'muted for 15 minutes',
      }),
    ).toHaveLength(0);
  });

  it('rejects an invalid status enum value', async () => {
    const errors = await build(ReviewReportDto, { status: 'NONSENSE' });
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('ListModerationDto', () => {
  it('accepts an empty payload (all filters optional)', async () => {
    expect(await build(ListModerationDto, {})).toHaveLength(0);
  });

  it('accepts targetUserId and userId filters together with pagination', async () => {
    expect(
      await build(ListModerationDto, {
        targetUserId: UUID_A,
        userId: UUID_B,
        page: 2,
        limit: 10,
      }),
    ).toHaveLength(0);
  });

  it('rejects a non-uuid targetUserId', async () => {
    const errors = await build(ListModerationDto, { targetUserId: 'nope' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('rejects a non-uuid userId', async () => {
    const errors = await build(ListModerationDto, { userId: 'nope' });
    expect(errors.length).toBeGreaterThan(0);
  });
});
