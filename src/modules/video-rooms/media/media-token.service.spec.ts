import { ConnectionType } from '../enums';
import { MediaTokenService } from './media-token.service';
import { MockMediaProvider } from './mock-media.provider';

describe('MediaTokenService', () => {
  let provider: MockMediaProvider;
  let service: MediaTokenService;

  beforeEach(() => {
    provider = new MockMediaProvider(true);
    service = new MediaTokenService(provider);
  });

  it('reports configured state from the provider', () => {
    expect(service.isConfigured()).toBe(true);
    expect(new MediaTokenService(new MockMediaProvider(false)).isConfigured()).toBe(false);
  });

  it('mints a fresh, unique media room id', () => {
    const a = service.mintMediaRoomId();
    const b = service.mintMediaRoomId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/[0-9a-f-]{36}/);
  });

  it('issues a PUBLISHER session when canPublish is true', () => {
    const session = service.issueForRoom({ userId: 'u1', mediaRoomId: 'r1', canPublish: true });
    expect(session.role).toBe(ConnectionType.PUBLISHER);
    expect(session.mediaRoomId).toBe('r1');
    expect(session.userId).toBe('u1');
  });

  it('issues a SUBSCRIBER session when canPublish is false (audience)', () => {
    const session = service.issueForRoom({ userId: 'u1', mediaRoomId: 'r1', canPublish: false });
    expect(session.role).toBe(ConnectionType.SUBSCRIBER);
  });

  it('mints a media room id when none is supplied', () => {
    const session = service.issueForRoom({ userId: 'u1', canPublish: true });
    expect(session.mediaRoomId).toMatch(/[0-9a-f-]{36}/);
  });
});
