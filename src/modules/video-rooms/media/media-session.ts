import type { ConnectionType, MediaProviderKind } from '../enums';

/**
 * A resolved media session — the credentials a client uses to join the RTC
 * room. Provider-agnostic and plain-serialisable: no SDK type leaks out of the
 * media layer into services or socket payloads. `mediaRoomId` is the provider's
 * room handle (e.g. a ZEGO room id), deliberately distinct from the app room id.
 */
export interface MediaSession {
  provider: MediaProviderKind;
  mediaRoomId: string;
  userId: string;
  /** PUBLISHER on a seat, SUBSCRIBER in the audience. */
  role: ConnectionType;
  appId: number;
  token: string;
  expiresInSeconds: number;
}
