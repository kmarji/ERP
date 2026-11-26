export const ALERT_STAGES = [0, 7, 30, 60] as const;

// The smallest alert stage already reached; null while the expiry is further away than the first warning.
export const alertStage = (daysLeft: number) => ALERT_STAGES.find((s) => daysLeft <= s) ?? null;

export function permitStatus(e: { status: string; needsWorkPermit: boolean; workPermitNumber: string | null; workPermitExpiry: Date | null }, today: Date) {
  if (!e.needsWorkPermit || e.status === 'TERMINATED') return null;
  const daysLeft = e.workPermitExpiry ? Math.round((e.workPermitExpiry.getTime() - today.getTime()) / 86_400_000) : null;
  if (daysLeft !== null && daysLeft < 0) return { state: 'EXPIRED' as const, daysLeft };
  if (daysLeft === null || !e.workPermitNumber) return { state: 'INCOMPLETE' as const, daysLeft };
  return alertStage(daysLeft) === null ? null : { state: 'EXPIRING' as const, daysLeft };
}
