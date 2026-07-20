import { BusinessException } from 'src/common/exceptions';
import type { ZegoTokenService } from 'src/infra/zego/zego-token.service';
import { ConnectionType, MediaProviderKind } from '../enums';
import { ZegoMediaProvider } from './zego-media.provider';

describe('ZegoMediaProvider', () => {
  let zego: jest.Mocked<Pick<ZegoTokenService, 'isConfigured' | 'buildRoomToken'>>;
  let provider: ZegoMediaProvider;

  beforeEach(() => {
    zego = {
      isConfigured: jest.fn().mockReturnValue(true),
      buildRoomToken: jest
        .fn()
        .mockReturnValue({ appId: 42, token: 'tok', expiresInSeconds: 3600 }),
    };
    provider = new ZegoMediaProvider(zego as unknown as ZegoTokenService);
  });

  it('advertises the ZEGO provider kind', () => {
    expect(provider.kind).toBe(MediaProviderKind.ZEGO);
  });

  it('delegates token generation to ZegoTokenService with canPublish=true for a PUBLISHER', () => {
    const session = provider.issueToken({
      userId: 'u1',
      mediaRoomId: 'room-handle',
      role: ConnectionType.PUBLISHER,
    });

    expect(zego.buildRoomToken).toHaveBeenCalledWith('u1', 'room-handle', true);
    expect(session).toEqual({
      provider: MediaProviderKind.ZEGO,
      mediaRoomId: 'room-handle',
      userId: 'u1',
      role: ConnectionType.PUBLISHER,
      appId: 42,
      token: 'tok',
      expiresInSeconds: 3600,
    });
  });

  it('passes canPublish=false for a SUBSCRIBER (audience)', () => {
    provider.issueToken({ userId: 'u1', mediaRoomId: 'r', role: ConnectionType.SUBSCRIBER });
    expect(zego.buildRoomToken).toHaveBeenCalledWith('u1', 'r', false);
  });

  it('refreshToken re-issues via buildRoomToken', () => {
    provider.refreshToken({ userId: 'u1', mediaRoomId: 'r', role: ConnectionType.PUBLISHER });
    expect(zego.buildRoomToken).toHaveBeenCalledWith('u1', 'r', true);
  });

  it('throws VIDEO_ROOM_MEDIA_NOT_CONFIGURED (503) when the provider is unconfigured', () => {
    zego.isConfigured.mockReturnValue(false);
    expect(() =>
      provider.issueToken({ userId: 'u1', mediaRoomId: 'r', role: ConnectionType.PUBLISHER }),
    ).toThrow(BusinessException);
    expect(zego.buildRoomToken).not.toHaveBeenCalled();
  });

  it('throws VIDEO_ROOM_CONFIG_INVALID when required params are missing', () => {
    expect(() =>
      provider.issueToken({ userId: '', mediaRoomId: 'r', role: ConnectionType.PUBLISHER }),
    ).toThrow(BusinessException);
  });
});
