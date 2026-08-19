import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DayOfWeek } from '@prisma/client';
import { ModeratorProvisioningService } from './moderator-provisioning.service';

/**
 * Spec: provisioning takes only email/password/state/shift from the admin.
 * Everything else — username, full name, country, the State/Country FKs, and
 * the RBAC state scope that actually gates moderator visibility — must be
 * derived without any further admin input.
 */
describe('ModeratorProvisioningService', () => {
  const activeState = {
    id: 'state-1',
    name: 'Karnataka',
    isActive: true,
    countryId: 'country-1',
    country: { id: 'country-1', code: 'IN', isActive: true },
  };

  const prisma = {
    state: { findMany: jest.fn() },
    role: { findUnique: jest.fn() },
    user: { findFirst: jest.fn(), update: jest.fn() },
    userCredential: { upsert: jest.fn() },
    userAuthProvider: { upsert: jest.fn() },
    userRole: { findFirst: jest.fn() },
    roleScope: { findFirst: jest.fn(), findMany: jest.fn() },
  } as any;
  const users = {
    isUsernameTaken: jest.fn(),
    createIdentity: jest.fn(),
  } as any;
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() } as any;
  const roleService = {
    assignRoleByName: jest.fn(),
    assignRoleScope: jest.fn(),
    removeRoleScope: jest.fn(),
  } as any;
  const identity = { syncHiddenState: jest.fn() } as any;
  const audit = { logAction: jest.fn() } as any;
  const passwords = { hash: jest.fn() } as any;
  const userLocation = { assignLocation: jest.fn() } as any;
  const moderatorShift = { assignShift: jest.fn() } as any;

  let service: ModeratorProvisioningService;

  const dto = {
    email: 'raviteja@gmail.com',
    password: 'a-long-password',
    stateIds: ['state-1'],
    shiftStartHour: 9,
    shiftStartMinute: 0,
    shiftEndHour: 15,
    shiftEndMinute: 0,
  };
  const ctx = { ip: '1.2.3.4', userAgent: 'jest' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    roles.getRoleNames.mockResolvedValue(['ADMIN']);
    prisma.state.findMany.mockResolvedValue([activeState]);
    prisma.user.findFirst.mockResolvedValue(null);
    users.isUsernameTaken.mockResolvedValue(false);
    users.createIdentity.mockResolvedValue({ id: 'new-1' });
    passwords.hash.mockResolvedValue('hashed');
    roleService.assignRoleByName.mockResolvedValue({ id: 'user-role-1' });
    roleService.assignRoleScope.mockResolvedValue({ id: 'scope-1' });
    prisma.roleScope.findFirst.mockResolvedValue(null);
    prisma.roleScope.findMany.mockResolvedValue([]);
    prisma.role.findUnique.mockResolvedValue({ id: 'role-moderator-1', name: 'MODERATOR' });

    service = new ModeratorProvisioningService(
      prisma,
      users,
      roles,
      roleService,
      identity,
      audit,
      passwords,
      userLocation,
      moderatorShift,
    );
  });

  describe('createModerator', () => {
    it('rejects an actor who is not Admin or Super Admin', async () => {
      roles.getRoleNames.mockResolvedValue(['USER']);
      await expect(service.createModerator('actor-1', dto, ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.state.findMany).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the state does not exist', async () => {
      prisma.state.findMany.mockResolvedValue([]);
      await expect(service.createModerator('actor-1', dto, ctx)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([
      ['state', { ...activeState, isActive: false }],
      ['country', { ...activeState, country: { ...activeState.country, isActive: false } }],
    ])('rejects an inactive %s in the state hierarchy', async (_label, state) => {
      prisma.state.findMany.mockResolvedValue([state]);
      await expect(service.createModerator('actor-1', dto, ctx)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('auto-generates a username and full name for a brand new account, without a profile country', async () => {
      await service.createModerator('actor-1', dto, ctx);
      expect(users.createIdentity).toHaveBeenCalledWith(
        expect.objectContaining({
          username: 'raviteja',
          fullName: 'Moderator raviteja',
          email: dto.email,
        }),
      );
      const createArgs = users.createIdentity.mock.calls[0][0];
      expect(createArgs.country).toBeUndefined();
    });

    it('retries with a numeric suffix when the derived username is taken', async () => {
      users.isUsernameTaken.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await service.createModerator('actor-1', dto, ctx);
      const username = users.createIdentity.mock.calls[0][0].username;
      expect(username).toMatch(/^raviteja\d{4}$/);
    });

    it('keeps the existing username when promoting an existing account, without regenerating one', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'existing-1',
        username: 'already_here',
        roles: ['USER'],
        emailVerifiedAt: null,
      });

      await service.createModerator('actor-1', dto, ctx);

      expect(users.createIdentity).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'existing-1' },
        data: expect.objectContaining({ status: 'ACTIVE' }),
      });
    });

    it('does not touch User.countryId/stateId/regionId for a new account', async () => {
      await service.createModerator('actor-1', dto, ctx);
      expect(userLocation.assignLocation).not.toHaveBeenCalled();
    });

    it('does not write country when promoting an existing account', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'existing-1',
        username: 'already_here',
        roles: ['USER'],
        emailVerifiedAt: null,
      });
      await service.createModerator('actor-1', dto, ctx);
      const updateArgs = prisma.user.update.mock.calls[0][0];
      expect(updateArgs.data.country).toBeUndefined();
    });

    it('grants a STATE role scope for every state in stateIds via setModeratorStates', async () => {
      await service.createModerator('actor-1', { ...dto, stateIds: ['state-1'] }, ctx);
      expect(roleService.assignRoleScope).toHaveBeenCalledWith(
        expect.objectContaining({ scopeType: 'STATE', stateId: 'state-1' }),
      );
    });

    it('assigns the shift with the given timings, defaulting days to all 7', async () => {
      await service.createModerator('actor-1', dto, ctx);
      expect(moderatorShift.assignShift).toHaveBeenCalledWith({
        moderatorId: 'new-1',
        daysOfWeek: [
          DayOfWeek.MONDAY,
          DayOfWeek.TUESDAY,
          DayOfWeek.WEDNESDAY,
          DayOfWeek.THURSDAY,
          DayOfWeek.FRIDAY,
          DayOfWeek.SATURDAY,
          DayOfWeek.SUNDAY,
        ],
        startHour: 9,
        startMinute: 0,
        endHour: 15,
        endMinute: 0,
        timezone: 'UTC',
        assignedBy: 'actor-1',
      });
    });

    it('honors explicit shiftDaysOfWeek and shiftTimezone when provided', async () => {
      await service.createModerator(
        'actor-1',
        {
          ...dto,
          shiftDaysOfWeek: [DayOfWeek.MONDAY, DayOfWeek.FRIDAY],
          shiftTimezone: 'Asia/Kolkata',
        },
        ctx,
      );
      expect(moderatorShift.assignShift).toHaveBeenCalledWith(
        expect.objectContaining({
          daysOfWeek: [DayOfWeek.MONDAY, DayOfWeek.FRIDAY],
          timezone: 'Asia/Kolkata',
        }),
      );
    });

    it('hides the account and writes an audit entry with the resulting stateIds', async () => {
      await service.createModerator('actor-1', dto, ctx);
      expect(identity.syncHiddenState).toHaveBeenCalledWith('new-1');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'moderator.created',
          resourceId: 'new-1',
          details: expect.objectContaining({ stateIds: ['state-1'] }),
        }),
      );
    });

    it('does not put the password in the audit trail', async () => {
      await service.createModerator('actor-1', dto, ctx);
      const logged = JSON.stringify(audit.logAction.mock.calls[0][0]);
      expect(logged).not.toContain(dto.password);
    });
  });

  describe('setModeratorStates', () => {
    const KA = {
      id: 'state-ka',
      name: 'Karnataka',
      isActive: true,
      countryId: 'country-in',
      country: { id: 'country-in', code: 'IN', isActive: true },
    };
    const AP = {
      id: 'state-ap',
      name: 'Andhra Pradesh',
      isActive: true,
      countryId: 'country-in',
      country: { id: 'country-in', code: 'IN', isActive: true },
    };

    beforeEach(() => {
      roleService.assignRoleByName.mockResolvedValue({ id: 'user-role-1' });
      prisma.roleScope.findMany = jest.fn().mockResolvedValue([]);
    });

    it('rejects an actor who is not Admin or Super Admin', async () => {
      roles.getRoleNames.mockResolvedValue(['USER']);
      await expect(
        service.setModeratorStates('mod-1', ['state-ka'], 'actor-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('throws NotFoundException when a stateId does not exist', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([]);
      await expect(
        service.setModeratorStates('mod-1', ['state-ka'], 'actor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an inactive state in the batch', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([{ ...KA, isActive: false }]);
      await expect(
        service.setModeratorStates('mod-1', ['state-ka'], 'actor-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a RoleScope row per new state when none exist yet', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([KA, AP]);
      await service.setModeratorStates('mod-1', ['state-ka', 'state-ap'], 'actor-1');

      expect(roleService.assignRoleScope).toHaveBeenCalledWith({
        userRoleId: 'user-role-1',
        scopeType: 'STATE',
        countryId: 'country-in',
        stateId: 'state-ka',
      });
      expect(roleService.assignRoleScope).toHaveBeenCalledWith({
        userRoleId: 'user-role-1',
        scopeType: 'STATE',
        countryId: 'country-in',
        stateId: 'state-ap',
      });
    });

    it('removes RoleScope rows for states no longer in the target set', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([KA]);
      prisma.roleScope.findMany = jest.fn().mockResolvedValue([
        { id: 'scope-ka', stateId: 'state-ka' },
        { id: 'scope-ap', stateId: 'state-ap' },
      ]);

      await service.setModeratorStates('mod-1', ['state-ka'], 'actor-1');

      expect(roleService.removeRoleScope).toHaveBeenCalledWith('scope-ap');
      expect(roleService.removeRoleScope).not.toHaveBeenCalledWith('scope-ka');
      expect(roleService.assignRoleScope).not.toHaveBeenCalled();
    });

    it('is a no-op when the target set already matches', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([KA]);
      prisma.roleScope.findMany = jest
        .fn()
        .mockResolvedValue([{ id: 'scope-ka', stateId: 'state-ka' }]);

      await service.setModeratorStates('mod-1', ['state-ka'], 'actor-1');

      expect(roleService.assignRoleScope).not.toHaveBeenCalled();
      expect(roleService.removeRoleScope).not.toHaveBeenCalled();
    });

    it('returns the resulting state id list', async () => {
      prisma.state.findMany = jest.fn().mockResolvedValue([KA, AP]);
      const result = await service.setModeratorStates('mod-1', ['state-ka', 'state-ap'], 'actor-1');
      expect(result).toEqual({ stateIds: ['state-ka', 'state-ap'] });
    });
  });

  describe('getModeratorStates', () => {
    it('returns the current STATE-scope state ids for the moderator', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);
      prisma.userRole.findFirst = jest.fn().mockResolvedValue({
        id: 'user-role-1',
        roleScopes: [
          { stateId: 'state-ka', state: { id: 'state-ka', name: 'Karnataka', code: 'KA', countryId: 'c1' } },
          { stateId: 'state-ap', state: { id: 'state-ap', name: 'Andhra Pradesh', code: 'AP', countryId: 'c1' } },
        ],
      });
      const result = await service.getModeratorStates('actor-1', 'mod-1');
      expect(result.stateIds).toEqual(['state-ka', 'state-ap']);
      expect(result.states).toHaveLength(2);
      expect(result.states[0].name).toBe('Karnataka');
    });

    it('returns an empty list when the moderator has no UserRole yet', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);
      prisma.userRole.findFirst = jest.fn().mockResolvedValue(null);
      const result = await service.getModeratorStates('actor-1', 'mod-1');
      expect(result).toEqual({ stateIds: [], states: [] });
    });
  });
});
