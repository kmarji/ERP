import { isOwner, RequestUser } from './tenant-context';

const user = (branchId: string | null, legalEntityId: string | null) => ({ roles: [{ key: 'OWNER', branchId, legalEntityId }], delegations: [] }) as unknown as RequestUser;

describe('isOwner', () => {
  it('accepts an owner of the whole company', () => expect(isOwner(user(null, null))).toBe(true));
  it('rejects an owner role limited to a branch', () => expect(isOwner(user('b1', null))).toBe(false));
  it('rejects an owner role limited to a legal entity', () => expect(isOwner(user(null, 'le1'))).toBe(false));
});
