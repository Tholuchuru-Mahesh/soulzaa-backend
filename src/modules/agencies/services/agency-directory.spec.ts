import { AgencyDirectoryService } from './agency-directory.service';

/**
 * The directory advertises agencies to ordinary members, so what it must get
 * right is: only approved agencies appear, the name shown is the trading name
 * the applicant registered, and nothing private leaks alongside it.
 */
describe('AgencyDirectoryService', () => {
  function build(requests: Array<Record<string, unknown>>) {
    const prisma: any = {
      roleRequest: { findMany: jest.fn().mockResolvedValue(requests) },
      agencyRelationship: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const profiles = {
      resolvePublicIdentities: jest
        .fn()
        .mockResolvedValue(new Map([['u-1', { displayName: 'Uday', avatarUrl: null }]])),
    };
    return { service: new AgencyDirectoryService(prisma, profiles as never), prisma, profiles };
  }

  it('lists only approved agency applications', async () => {
    const { service, prisma } = build([]);

    await service.list();

    // An application still in review is not an agency and must not be listed.
    expect(prisma.roleRequest.findMany.mock.calls[0][0].where).toEqual({
      type: 'AGENCY',
      status: 'APPROVED',
    });
  });

  it('shows the trading name from the application form', async () => {
    const { service } = build([
      {
        subjectUserId: 'u-1',
        formData: { agencyName: 'Soulzaa Stars' },
        decidedAt: new Date('2026-08-01'),
      },
    ]);

    const res = await service.list();

    expect(res.items[0].agencyName).toBe('Soulzaa Stars');
  });

  it('keeps the newest approval for an agency that applied twice', async () => {
    // findMany is ordered newest first, so the first row wins.
    const { service } = build([
      {
        subjectUserId: 'u-1',
        formData: { agencyName: 'New Name' },
        decidedAt: new Date('2026-08-02'),
      },
      {
        subjectUserId: 'u-1',
        formData: { agencyName: 'Old Name' },
        decidedAt: new Date('2026-01-01'),
      },
    ]);

    const res = await service.list();

    expect(res.items).toHaveLength(1);
    expect(res.items[0].agencyName).toBe('New Name');
  });

  it('falls back to the account name when the form carried none', async () => {
    const { service } = build([
      { subjectUserId: 'u-1', formData: {}, decidedAt: new Date('2026-08-01') },
    ]);

    const res = await service.list();

    // Never blank — an unnamed row is unusable in a list you tap to join.
    expect(res.items[0].agencyName).toBe('Uday');
  });

  it('exposes only public fields', async () => {
    const { service } = build([
      { subjectUserId: 'u-1', formData: { agencyName: 'Stars' }, decidedAt: new Date() },
    ]);

    const res = await service.list();

    // Anything beyond these would be advertising an agency's private
    // operations to every member of the platform.
    expect(Object.keys(res.items[0]).sort()).toEqual(
      ['agencyId', 'agencyName', 'approvedAt', 'avatarUrl', 'memberCount', 'ownerName'].sort(),
    );
  });

  it('caps the page size', async () => {
    const { service } = build([]);

    const res = await service.list({ limit: 9999 });

    expect(res.limit).toBe(50);
  });

  it('searches on the trading name', async () => {
    const { service } = build([
      { subjectUserId: 'u-1', formData: { agencyName: 'Soulzaa Stars' }, decidedAt: new Date() },
      { subjectUserId: 'u-2', formData: { agencyName: 'Other Agency' }, decidedAt: new Date() },
    ]);

    const res = await service.list({ search: 'stars' });

    expect(res.total).toBe(1);
    expect(res.items[0].agencyName).toBe('Soulzaa Stars');
  });
});
