// Spaces are removed before validating, so the length rule counts real characters only.
export const IBAN = /^[A-Z0-9]{10,40}$/;
export const compactIban = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.replace(/\s/g, '').toUpperCase() : value);
