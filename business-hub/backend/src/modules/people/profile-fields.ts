// Optional text items on the employee profile.
export const PROFILE = ['gender', 'maritalStatus', 'workType', 'department', 'section', 'workLocation'] as const;
export type Profile = Partial<Record<(typeof PROFILE)[number], string | null>>;

// Only the items that were sent; blank means cleared.
export const profileData = (input: Profile): Profile => Object.fromEntries(PROFILE.filter((k) => input[k] !== undefined).map((k) => [k, input[k]?.trim() || null]));
