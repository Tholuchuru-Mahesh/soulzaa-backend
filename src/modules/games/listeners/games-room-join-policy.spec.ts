import { GameLobbyStatus, GameSessionStatus } from '@prisma/client';
import { ROOM_JOIN_POLICY_REGISTRY, type RoomJoinPolicyRegistry } from 'src/infra/socket/room-join-policy.interface';
import { GAMES_NAMESPACE } from '../constants/games.constants';
import { GamesRepository } from '../repositories/games.repository';
import { AudioRoomGameAuthzService } from '../services/audio-room-game-authz.service';
import { GamesRoomJoinPolicy } from './games-room-join-policy';

const SESSION_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'; // genuine UUID v4
const OTHER_SESSION_ID = '9c8b0a1d-9f4a-4a4a-9c6c-3b2a1d0e5f4a';
const ROOM = 'room-1';
const USER = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    definitionId: 'def-1',
    code: 'GREEDY',
    lobbyId: 'lobby-1',
    joinCode: 'ABCDEF',
    hostId: USER,
    roomId: null,
    category: 'PREMIUM',
    currency: 'GOLD',
    stake: 100n,
    playerCount: 2,
    potAmount: 200n,
    status: GameSessionStatus.ACTIVE,
    startedAt: new Date(),
    settledAt: null,
    ...overrides,
  };
}

function lobby(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lobby-1',
    definitionId: 'def-1',
    code: 'ABCDEF',
    hostId: USER,
    roomId: null,
    category: 'PREMIUM',
    currency: 'GOLD',
    stake: 100n,
    maxPlayers: 8,
    status: GameLobbyStatus.OPEN,
    sessionId: null,
    expiresAt: new Date(Date.now() + 60000),
    ...overrides,
  };
}

describe('GamesRoomJoinPolicy', () => {
  let registry: RoomJoinPolicyRegistry;
  let repo: Record<string, jest.Mock>;
  let authz: Record<string, jest.Mock>;
  let policy: GamesRoomJoinPolicy;

  beforeEach(() => {
    registry = new Map();
    repo = {
      getSession: jest.fn().mockResolvedValue(null),
      getParticipant: jest.fn().mockResolvedValue(null),
      getLobbyByCode: jest.fn().mockResolvedValue(null),
      getMember: jest.fn().mockResolvedValue(null),
    };
    authz = { isMember: jest.fn().mockResolvedValue(false) };
    policy = new GamesRoomJoinPolicy(
      registry,
      repo as unknown as GamesRepository,
      authz as unknown as AudioRoomGameAuthzService,
    );
  });

  it('self-registers on the /games namespace on init', () => {
    expect(registry.has(GAMES_NAMESPACE)).toBe(false);
    policy.onModuleInit();
    expect(registry.get(GAMES_NAMESPACE)).toBe(policy);
  });

  describe('session rooms (UUID room id)', () => {
    it('denies when the session does not exist', async () => {
      await expect(policy.canJoin(USER, SESSION_ID)).resolves.toBe('deny');
    });

    it('denies when the session is not active', async () => {
      repo.getSession.mockResolvedValue(session({ status: GameSessionStatus.COMPLETED }));
      await expect(policy.canJoin(USER, SESSION_ID)).resolves.toBe('deny');
    });

    it('admits a GameParticipant as a player', async () => {
      repo.getSession.mockResolvedValue(session());
      repo.getParticipant.mockResolvedValue({ id: 'p1' });
      await expect(policy.canJoin(USER, SESSION_ID)).resolves.toBe('player');
      expect(authz.isMember).not.toHaveBeenCalled();
    });

    it('admits a room-bound session room-member as a spectator', async () => {
      repo.getSession.mockResolvedValue(session({ roomId: ROOM }));
      repo.getParticipant.mockResolvedValue(null);
      authz.isMember.mockResolvedValue(true);
      await expect(policy.canJoin(OTHER, SESSION_ID)).resolves.toBe('spectator');
      expect(authz.isMember).toHaveBeenCalledWith(ROOM, OTHER);
    });

    it('denies a non-member, non-participant of a room-bound session', async () => {
      repo.getSession.mockResolvedValue(session({ roomId: ROOM }));
      repo.getParticipant.mockResolvedValue(null);
      authz.isMember.mockResolvedValue(false);
      await expect(policy.canJoin(OTHER, SESSION_ID)).resolves.toBe('deny');
    });

    it('denies a non-participant of a session with no roomId (no spectator path)', async () => {
      repo.getSession.mockResolvedValue(session());
      repo.getParticipant.mockResolvedValue(null);
      await expect(policy.canJoin(OTHER, SESSION_ID)).resolves.toBe('deny');
    });

    it('denies an unknown session UUID even when the caller is a participant of another session', async () => {
      repo.getSession.mockResolvedValue(null);
      repo.getParticipant.mockResolvedValue({ id: 'p1' });
      await expect(policy.canJoin(USER, OTHER_SESSION_ID)).resolves.toBe('deny');
    });
  });

  describe('lobby rooms (join-code room id)', () => {
    it('denies when the lobby does not exist', async () => {
      await expect(policy.canJoin(USER, 'ABCDEF')).resolves.toBe('deny');
    });

    it('denies when the lobby is not open', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby({ status: GameLobbyStatus.STARTED }));
      await expect(policy.canJoin(USER, 'ABCDEF')).resolves.toBe('deny');
    });

    it('admits a GameLobbyMember as a player', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getMember.mockResolvedValue({ id: 'm1' });
      await expect(policy.canJoin(USER, 'ABCDEF')).resolves.toBe('player');
    });

    it('denies a non-member — there is no lobby spectating', async () => {
      repo.getLobbyByCode.mockResolvedValue(lobby());
      repo.getMember.mockResolvedValue(null);
      await expect(policy.canJoin(OTHER, 'ABCDEF')).resolves.toBe('deny');
    });
  });
});