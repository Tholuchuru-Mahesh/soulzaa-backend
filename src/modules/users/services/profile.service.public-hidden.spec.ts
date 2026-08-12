import { ProfileService } from './profile.service';
import type { ProfileView } from '../interfaces/profile.interface';

/**
 * getCards covers list surfaces, but a direct lookup by handle or id is a second
 * way in. Both public entry points (`getPublicProfile`, `getProfileByUsername`)
 * share one privacy gate, so the check lives there rather than in a controller.
 */
describe('ProfileService — public lookup of a hidden account', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';

  function build(opts: {
    target: { id: string; isHiddenAccount: boolean };
    viewerHidden: boolean;
  }) {
    // The target resolves through findByIdOrPrefix; any *other* id reaching
    // findById is the viewer-is-staff lookup, which answers with viewerHidden.
    const byId = async (id: string) =>
      id === opts.target.id ? opts.target : { id, isHiddenAccount: opts.viewerHidden };
    const users = {
      findById: jest.fn(byId),
      findByIdOrPrefix: jest.fn(byId),
      findByUsername: jest.fn(async () => opts.target),
    };
    const privacy = { check: jest.fn().mockResolvedValue(true) };

    const service = Object.create(ProfileService.prototype) as ProfileService;
    Object.assign(service, { users, privacy });
    (
      service as unknown as { getProfileView: (id: string) => Promise<ProfileView | null> }
    ).getProfileView = async (id) => ({ id }) as ProfileView;

    return { service, privacy };
  }

  it('hides a staff account from an anonymous viewer', async () => {
    const { service } = build({
      target: { id: UUID, isHiddenAccount: true },
      viewerHidden: false,
    });
    await expect(service.getPublicProfile(UUID)).resolves.toBeNull();
  });

  it('hides a staff account from an ordinary signed-in user', async () => {
    const { service } = build({
      target: { id: UUID, isHiddenAccount: true },
      viewerHidden: false,
    });
    await expect(service.getPublicProfile(UUID, 'viewer-1')).resolves.toBeNull();
  });

  it('resolves a staff account for another staff viewer', async () => {
    const { service } = build({
      target: { id: UUID, isHiddenAccount: true },
      viewerHidden: true,
    });
    await expect(service.getPublicProfile(UUID, 'admin-2')).resolves.not.toBeNull();
  });

  it('does not spend a viewer lookup when the target is not hidden', async () => {
    const { service } = build({
      target: { id: UUID, isHiddenAccount: false },
      viewerHidden: false,
    });
    await expect(service.getPublicProfile(UUID, 'viewer-1')).resolves.not.toBeNull();
  });

  it('applies the same rule to username lookups', async () => {
    const { service } = build({
      target: { id: UUID, isHiddenAccount: true },
      viewerHidden: false,
    });
    await expect(service.getProfileByUsername('ops1', 'viewer-1')).resolves.toBeNull();
  });

  it('never reaches the privacy check for a hidden target — absence is the answer', async () => {
    const { service, privacy } = build({
      target: { id: UUID, isHiddenAccount: true },
      viewerHidden: false,
    });
    await service.getPublicProfile(UUID, 'viewer-1');
    expect(privacy.check).not.toHaveBeenCalled();
  });
});
