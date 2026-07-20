// media-stage.spec.ts
import { ConnectionType, ConnectionStatus, MediaStreamState, MediaStreamKind } from '../enums';
import { newParticipant, upsertParticipant, toMediaStageView } from './media-stage';
import { DEFAULT_BEAUTY } from './beauty-settings';

const now = '2026-07-20T00:00:00.000Z';

describe('media-stage', () => {
  it('newParticipant seeds sensible defaults', () => {
    const p = newParticipant({
      userId: 'u1',
      seatIndex: 2,
      role: ConnectionType.PUBLISHER,
      nowIso: now,
      defaultBeauty: DEFAULT_BEAUTY,
    });
    expect(p.streamState).toBe(MediaStreamState.CREATED);
    expect(p.connection).toBe(ConnectionStatus.CONNECTING);
    expect(p.streamKind).toBe(MediaStreamKind.CAMERA);
    expect(p.camera.on).toBe(false);
    expect(p.mic.selfMuted).toBe(false);
    expect(p.subscriptions).toEqual([]);
  });
  it('upsertParticipant patches an existing entry immutably', () => {
    const p = newParticipant({
      userId: 'u1',
      seatIndex: 0,
      role: ConnectionType.PUBLISHER,
      nowIso: now,
      defaultBeauty: DEFAULT_BEAUTY,
    });
    const list = [p];
    const next = upsertParticipant(list, 'u1', (x) => ({
      ...x,
      camera: { ...x.camera, on: true },
    }));
    expect(next[0].camera.on).toBe(true);
    expect(list[0].camera.on).toBe(false); // original untouched
  });
  it('upsertParticipant is a no-op for an unknown user', () => {
    const list = [
      newParticipant({
        userId: 'u1',
        seatIndex: 0,
        role: ConnectionType.PUBLISHER,
        nowIso: now,
        defaultBeauty: DEFAULT_BEAUTY,
      }),
    ];
    expect(upsertParticipant(list, 'ghost', (x) => x)).toBe(list);
  });
  it('toMediaStageView passes through the snapshot fields', () => {
    const v = toMediaStageView({
      roomId: 'r',
      version: 3,
      updatedAt: now,
      mediaRoomId: 'm',
      provider: 'ZEGO' as never,
      participants: [],
    });
    expect(v.version).toBe(3);
    expect(v.mediaRoomId).toBe('m');
  });
});
