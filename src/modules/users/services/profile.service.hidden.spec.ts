import { ProfileService } from './profile.service';
import type { ProfileView } from '../interfaces/profile.interface';

/**
 * `getCards` is the sanctioned cross-module read of user identity — nine modules
 * resolve followers, friends, room members, live viewers, gift panels and
 * mentions through it. Filtering here is what makes a staff account invisible
 * everywhere at once, so these tests guard the single highest-leverage seam in
 * the invisibility work.
 */
function view(id: string, hidden: boolean): ProfileView {
  return {
    id,
    username: id,
    fullName: null,
    bio: null,
    avatarUrl: null,
    coverUrl: null,
    gender: null,
    birthday: null,
    country: null,
    state: null,
    city: null,
    preferredLanguage: null,
    isHiddenAccount: hidden,
    statistics: { level: 1, vipLevel: 0 } as ProfileView['statistics'],
    verification: { verified: false } as ProfileView['verification'],
    createdAt: new Date('2026-01-01'),
  };
}

describe('ProfileService.getCards — hidden accounts', () => {
  function serviceWith(views: Record<string, ProfileView>) {
    const service = Object.create(ProfileService.prototype) as ProfileService;
    (
      service as unknown as { getProfileView: (id: string) => Promise<ProfileView | null> }
    ).getProfileView = async (id: string) => views[id] ?? null;
    return service;
  }

  it('drops hidden accounts from resolved cards', async () => {
    const service = serviceWith({
      'u-1': view('u-1', false),
      'admin-1': view('admin-1', true),
      'u-2': view('u-2', false),
    });

    const cards = await service.getCards(['u-1', 'admin-1', 'u-2']);

    expect(cards.map((c) => c.id)).toEqual(['u-1', 'u-2']);
  });

  it('returns an empty list when every id is hidden', async () => {
    const service = serviceWith({ 'admin-1': view('admin-1', true) });
    await expect(service.getCards(['admin-1'])).resolves.toEqual([]);
  });

  it('leaves ordinary accounts untouched', async () => {
    const service = serviceWith({ 'u-1': view('u-1', false) });
    const cards = await service.getCards(['u-1']);
    expect(cards).toHaveLength(1);
    expect(cards[0].username).toBe('u-1');
  });
});
