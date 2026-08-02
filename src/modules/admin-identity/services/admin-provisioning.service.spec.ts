import { ForbiddenException } from '@nestjs/common';
import { AdminProvisioningService } from './admin-provisioning.service';

/**
 * Spec §1: Admin is created only by Super Admin, cannot create another Admin,
 * and cannot suspend or delete Super Admin. Each rule is a distinct route to
 * privilege escalation, so each gets its own guard clause and its own test.
 */
describe('AdminProvisioningService', () => {
  const auth = { register: jest.fn() } as any;
  const users = { setStatus: jest.fn(), findById: jest.fn() } as any;
  const roles = { getRoleNames: jest.fn(), getUserIdsWithAnyRole: jest.fn() } as any;
  const roleService = { assignRoleByName: jest.fn() } as any;
  const identity = { syncHiddenState: jest.fn() } as any;
  const audit = { logAction: jest.fn() } as any;

  let service: AdminProvisioningService;

  const dto = {
    fullName: 'Operations Lead',
    username: 'ops1',
    mobile: '+15551234567',
    email: 'ops1@soulzaa.com',
    password: 'a-long-password',
    dateOfBirth: '1995-04-12',
    country: 'IN',
  };
  const ctx = { ip: '1.2.3.4', userAgent: 'jest' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    auth.register.mockResolvedValue({ user: { id: 'new-1' } });
    service = new AdminProvisioningService(auth, users, roles, roleService, identity, audit);
  });

  describe('createAdmin', () => {
    it('rejects an actor who is only ADMIN — an Admin cannot create another Admin', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);
      await expect(service.createAdmin('actor-1', dto, ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(auth.register).not.toHaveBeenCalled();
    });

    it('rejects an unprivileged actor', async () => {
      roles.getRoleNames.mockResolvedValue(['USER']);
      await expect(service.createAdmin('actor-1', dto, ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('creates the account through the auth module rather than writing users directly', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await service.createAdmin('actor-1', dto, ctx);
      expect(auth.register).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email, username: dto.username }),
        ctx,
      );
    });

    it('grants ADMIN to the new account', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await service.createAdmin('actor-1', dto, ctx);
      expect(roleService.assignRoleByName).toHaveBeenCalledWith('new-1', 'ADMIN', 'actor-1');
    });

    it('hides the new account immediately rather than waiting for the role event', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await service.createAdmin('actor-1', dto, ctx);
      expect(identity.syncHiddenState).toHaveBeenCalledWith('new-1');
    });

    it('writes an audit entry', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await service.createAdmin('actor-1', dto, ctx);
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: 'actor-1',
          action: 'admin.created',
          resourceId: 'new-1',
        }),
      );
    });

    it('does not put the password in the audit trail', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await service.createAdmin('actor-1', dto, ctx);
      const logged = JSON.stringify(audit.logAction.mock.calls[0][0]);
      expect(logged).not.toContain(dto.password);
    });
  });

  describe('setStatus', () => {
    it('refuses to suspend a SUPER_ADMIN', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      await expect(service.setStatus('actor-1', 'target-1', 'SUSPENDED')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(users.setStatus).not.toHaveBeenCalled();
    });

    it('suspends an ADMIN when the actor is SUPER_ADMIN', async () => {
      roles.getRoleNames.mockImplementation(async (id: string) =>
        id === 'actor-1' ? ['SUPER_ADMIN'] : ['ADMIN'],
      );
      await service.setStatus('actor-1', 'target-1', 'SUSPENDED');
      expect(users.setStatus).toHaveBeenCalledWith('target-1', 'SUSPENDED');
    });

    it('rejects a status change by a non-SUPER_ADMIN actor', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);
      await expect(service.setStatus('actor-1', 'target-1', 'SUSPENDED')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('audits a status change', async () => {
      roles.getRoleNames.mockImplementation(async (id: string) =>
        id === 'actor-1' ? ['SUPER_ADMIN'] : ['ADMIN'],
      );
      await service.setStatus('actor-1', 'target-1', 'SUSPENDED');
      expect(audit.logAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'admin.status_changed', resourceId: 'target-1' }),
      );
    });
  });

  describe('listAdmins', () => {
    it('refuses an ADMIN — an Admin cannot enumerate other Admins', async () => {
      roles.getRoleNames.mockResolvedValue(['ADMIN']);
      await expect(service.listAdmins('actor-1')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns the ADMIN holders for a SUPER_ADMIN', async () => {
      roles.getRoleNames.mockResolvedValue(['SUPER_ADMIN']);
      roles.getUserIdsWithAnyRole.mockResolvedValue(['a-1']);
      users.findById.mockResolvedValue({ id: 'a-1', username: 'ops1', status: 'ACTIVE' });

      const list = await service.listAdmins('actor-1');

      expect(roles.getUserIdsWithAnyRole).toHaveBeenCalledWith(['ADMIN']);
      expect(list).toEqual([{ id: 'a-1', username: 'ops1', status: 'ACTIVE' }]);
    });
  });
});
