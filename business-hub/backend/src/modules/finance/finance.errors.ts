export type FinanceErrorCode = 'PERIOD_LOCKED' | 'MISSING_ACCOUNT' | 'UNBALANCED' | 'INVALID_JOURNAL';

// Domain errors callers (e.g. receiving) convert into workflow exceptions instead of failing the request.
export class FinanceError extends Error {
  constructor(
    public readonly code: FinanceErrorCode,
    message: string,
  ) {
    super(message);
  }
}
