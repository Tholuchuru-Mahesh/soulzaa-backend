import { FamilyRequestStatus, FamilyRole } from '@prisma/client';
import { IEventBus } from 'src/common/events';
import { BusinessException } from 'src/common/exceptions';
import { FamiliesRepository } from '../repositories/families.repository';
import { FamiliesService } from './families.service';

function mockFamily(overrides: Record<string, any> = {}): any {
  return {
    id: 'family-1',
    name: 'Gamerz',
    description: 'Elite guild',
    logoKey: 'logo-1',
    leaderId: 'user-1',
    level: 1,
    exp: 0n,
    memberCount: 1,
    maxMembers: 100,
    autoAccept: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function mockMember(overrides: Record<string, any> = {}): any {
  return {
    id: 'member-1',
    familyId: 'family-1',
    userId: 'user-1',
    role: FamilyRole.LEADER,
    contributionPoints: 0,
    joinedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('FamiliesService', () => {
  let repo: Record<string, jest.Mock>;
  let bus: jest.Mocked<IEventBus>;
  let service: FamiliesService;

  beforeEach(() => {
    repo = {
      findById: jest.fn().mockResolvedValue(mockFamily()),
      findByName: jest.fn().mockResolvedValue(null),
      findMemberByUserId: jest.fn().mockResolvedValue(null),
      findRequestById: jest.fn().mockResolvedValue(null),
      findRequestByFamilyAndUser: jest.fn().mockResolvedValue(null),
      createFamily: jest.fn().mockImplementation((f) => Promise.resolve(mockFamily(f))),
      deleteFamily: jest.fn().mockResolvedValue(undefined),
      updateFamily: jest.fn().mockImplementation((_id, d) => Promise.resolve(mockFamily(d))),
      updateMember: jest.fn().mockImplementation((_id, m) => Promise.resolve(mockMember(m))),
      addMember: jest
        .fn()
        .mockImplementation((f, u, r) =>
          Promise.resolve(mockMember({ familyId: f, userId: u, role: r })),
        ),
      removeMember: jest.fn().mockResolvedValue(undefined),
      createRequest: jest
        .fn()
        .mockImplementation((r) =>
          Promise.resolve({ id: 'req-1', status: FamilyRequestStatus.PENDING, ...r }),
        ),
      updateRequest: jest.fn().mockImplementation((_id, r) => Promise.resolve({ id: _id, ...r })),
      acceptRequest: jest
        .fn()
        .mockImplementation((_reqId, f, u) =>
          Promise.resolve(mockMember({ familyId: f, userId: u })),
        ),
      rejectRequest: jest.fn().mockResolvedValue(undefined),
      listFamilies: jest.fn().mockResolvedValue([[], 0]),
      listMembers: jest.fn().mockResolvedValue([[], 0]),
      listRequests: jest.fn().mockResolvedValue([[], 0]),
      logAction: jest.fn().mockResolvedValue(undefined),
      listLogs: jest.fn().mockResolvedValue([[], 0]),
    };
    bus = { publish: jest.fn().mockResolvedValue(undefined), subscribe: jest.fn() };
    service = new FamiliesService(repo as unknown as FamiliesRepository, bus);
  });

  describe('create', () => {
    it('creates a family successfully', async () => {
      const res = await service.create('user-1', { name: 'Gamerz', description: 'Elite' });
      expect(repo.findMemberByUserId).toHaveBeenCalledWith('user-1');
      expect(repo.findByName).toHaveBeenCalledWith('Gamerz');
      expect(repo.createFamily).toHaveBeenCalled();
      expect(bus.publish).toHaveBeenCalledWith(expect.objectContaining({ name: 'family.created' }));
      expect(res.name).toBe('Gamerz');
    });

    it('throws ALREADY_IN_FAMILY if user belongs to a family', async () => {
      repo.findMemberByUserId.mockResolvedValue(mockMember());
      await expect(service.create('user-1', { name: 'Gamerz' })).rejects.toThrow(
        new BusinessException('ALREADY_IN_FAMILY', 'You are already a member of a family.'),
      );
    });

    it('throws FAMILY_NAME_EXISTS if name is already taken', async () => {
      repo.findByName.mockResolvedValue(mockFamily());
      await expect(service.create('user-1', { name: 'Gamerz' })).rejects.toThrow(
        new BusinessException('FAMILY_NAME_EXISTS', 'Family name is already taken.'),
      );
    });
  });

  describe('join', () => {
    it('joins immediately if autoAccept is true', async () => {
      repo.findById.mockResolvedValue(mockFamily({ autoAccept: true }));
      const res = await service.join('user-2', 'family-1');
      expect(repo.addMember).toHaveBeenCalledWith('family-1', 'user-2', FamilyRole.MEMBER);
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'family.member_joined' }),
      );
      expect(res.joined).toBe(true);
    });

    it('creates a request if autoAccept is false', async () => {
      const res = await service.join('user-2', 'family-1');
      expect(repo.createRequest).toHaveBeenCalled();
      expect(res.joined).toBe(false);
      expect(res.request.status).toBe(FamilyRequestStatus.PENDING);
    });
  });

  describe('leave', () => {
    it('allows a member to leave', async () => {
      repo.findMemberByUserId.mockResolvedValue(mockMember({ role: FamilyRole.MEMBER }));
      await service.leave('user-1', 'family-1');
      expect(repo.removeMember).toHaveBeenCalledWith('family-1', 'user-1', 'user-1');
      expect(bus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'family.member_left' }),
      );
    });

    it('prevents a Leader from leaving', async () => {
      repo.findMemberByUserId.mockResolvedValue(mockMember({ role: FamilyRole.LEADER }));
      await expect(service.leave('user-1', 'family-1')).rejects.toThrow(
        new BusinessException(
          'LEADER_CANNOT_LEAVE',
          'Leaders cannot leave without transferring leadership or disbanding the family.',
        ),
      );
    });
  });

  describe('kick', () => {
    it('allows a leader to kick a member', async () => {
      repo.findMemberByUserId.mockImplementation((u) => {
        if (u === 'user-1')
          return Promise.resolve(mockMember({ userId: 'user-1', role: FamilyRole.LEADER }));
        if (u === 'user-2')
          return Promise.resolve(mockMember({ userId: 'user-2', role: FamilyRole.MEMBER }));
        return Promise.resolve(null);
      });

      await service.kick('user-1', 'family-1', 'user-2');
      expect(repo.removeMember).toHaveBeenCalledWith('family-1', 'user-2', 'user-1');
    });

    it('prevents a co-leader from kicking another co-leader', async () => {
      repo.findMemberByUserId.mockImplementation((u) => {
        if (u === 'user-1')
          return Promise.resolve(mockMember({ userId: 'user-1', role: FamilyRole.CO_LEADER }));
        if (u === 'user-2')
          return Promise.resolve(mockMember({ userId: 'user-2', role: FamilyRole.CO_LEADER }));
        return Promise.resolve(null);
      });

      await expect(service.kick('user-1', 'family-1', 'user-2')).rejects.toThrow(
        new BusinessException(
          'FAMILY_ROLE_FORBIDDEN',
          'You do not have permission to kick this member.',
        ),
      );
    });
  });

  describe('promote', () => {
    it('allows a Leader to promote a member to Co-Leader', async () => {
      repo.findMemberByUserId.mockImplementation((u) => {
        if (u === 'user-1')
          return Promise.resolve(mockMember({ userId: 'user-1', role: FamilyRole.LEADER }));
        if (u === 'user-2')
          return Promise.resolve(
            mockMember({ userId: 'user-2', role: FamilyRole.MEMBER, id: 'target-mem' }),
          );
        return Promise.resolve(null);
      });

      await service.promote('user-1', 'family-1', { userId: 'user-2', role: FamilyRole.CO_LEADER });
      expect(repo.updateMember).toHaveBeenCalledWith('target-mem', { role: FamilyRole.CO_LEADER });
    });

    it('prevents a Co-Leader from promoting a member to Co-Leader', async () => {
      repo.findMemberByUserId.mockImplementation((u) => {
        if (u === 'user-1')
          return Promise.resolve(mockMember({ userId: 'user-1', role: FamilyRole.CO_LEADER }));
        if (u === 'user-2')
          return Promise.resolve(mockMember({ userId: 'user-2', role: FamilyRole.MEMBER }));
        return Promise.resolve(null);
      });

      await expect(
        service.promote('user-1', 'family-1', { userId: 'user-2', role: FamilyRole.CO_LEADER }),
      ).rejects.toThrow(
        new BusinessException(
          'FAMILY_ROLE_FORBIDDEN',
          'Only the Leader can promote a member to Co-Leader.',
        ),
      );
    });
  });
});
