import type { ConnectionStatus, ConnectionType } from '../enums';

/**
 * A descriptor of a live client media connection, as tracked by the session
 * layer. Plain-serialisable so it can move through Redis + socket payloads
 * unchanged. Distinct from MediaSession (the issued credentials): this is the
 * runtime connection's observed state.
 */
export interface MediaConnection {
  socketId: string;
  userId: string;
  roomId: string;
  mediaRoomId: string;
  role: ConnectionType;
  status: ConnectionStatus;
  connectedAt: string;
}
