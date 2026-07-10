import { orderPair } from './friendship.repository';

describe('orderPair (canonical friendship ordering)', () => {
  it('orders a pair deterministically regardless of argument order', () => {
    const a = orderPair('aaa', 'bbb');
    const b = orderPair('bbb', 'aaa');
    expect(a).toEqual({ userAId: 'aaa', userBId: 'bbb' });
    expect(b).toEqual({ userAId: 'aaa', userBId: 'bbb' });
    expect(a).toEqual(b);
  });

  it('always yields userAId < userBId', () => {
    const ids = ['z9', 'a1', 'm5', '00', 'ff'];
    for (const x of ids) {
      for (const y of ids) {
        if (x === y) continue;
        const { userAId, userBId } = orderPair(x, y);
        expect(userAId < userBId).toBe(true);
      }
    }
  });
});
