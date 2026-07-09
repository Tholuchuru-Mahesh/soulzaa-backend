import { NullRelationshipProvider } from './null-relationship.provider';

describe('NullRelationshipProvider', () => {
  const provider = new NullRelationshipProvider();

  it('reports no friendship (no social graph yet)', async () => {
    await expect(provider.isFriend('a', 'b')).resolves.toBe(false);
  });

  it('reports no follower relationship', async () => {
    await expect(provider.isFollower('a', 'b')).resolves.toBe(false);
  });
});
