import { z } from 'zod';

// Statutory and contractual parameters live in versioned, effective-dated rule sets, never in code (brief s11.2, PAY-01).
// The numbers below are PLACEHOLDERS: Jordanian payroll rules need current legal verification before any run is finalized.
export const RulesSchema = z.object({
  currency: z.string().default('JOD'),
  workingDaysPerMonth: z.number().positive().default(30),
  dailyHours: z.number().positive().default(8),
  overtime: z
    .object({
      multiplier: z.number().min(1).default(1.25),
      dailyThresholdMinutes: z.number().positive().default(480),
      weeklyThresholdMinutes: z.number().positive().default(2880),
      maxMonthlyHours: z.number().positive().default(60),
    })
    .default({}),
  ssc: z
    .object({
      employeeRate: z.number().min(0).max(1).default(0.075),
      employerRate: z.number().min(0).max(1).default(0.1425),
      monthlyCeiling: z.number().positive().nullable().default(null),
    })
    .default({}),
  tax: z
    .object({
      annualExemption: z.number().min(0).default(9000),
      familyExemption: z.number().min(0).default(0),
      brackets: z
        .array(z.object({ upTo: z.number().positive().nullable(), rate: z.number().min(0).max(1) }))
        .default([
          { upTo: 5000, rate: 0.05 },
          { upTo: 10000, rate: 0.1 },
          { upTo: 15000, rate: 0.15 },
          { upTo: 20000, rate: 0.2 },
          { upTo: null, rate: 0.25 },
        ]),
    })
    .default({}),
  lateness: z.object({ graceMinutes: z.number().min(0).default(10), deduct: z.boolean().default(false) }).default({}),
  scheduling: z.object({ minRestHours: z.number().min(0).default(8), maxWeeklyMinutes: z.number().positive().default(3600) }).default({}),
  minimumWageMonthly: z.number().min(0).default(260),
  anomalyPct: z.number().positive().default(30),
  obligations: z.object({ dueDaysAfterPeriod: z.number().min(0).default(15) }).default({}),
  endOfService: z.object({ enabled: z.boolean().default(false), monthsFactor: z.number().min(0).default(0) }).default({}),
  leave: z.object({ annualDays: z.number().min(0).default(14), sickDays: z.number().min(0).default(14) }).default({}),
});

export type PayrollRules = z.infer<typeof RulesSchema>;

export const PLACEHOLDER_NOTE = 'PLACEHOLDER VALUES. Verify against current Jordanian labour, social security and income tax rules with a qualified advisor before finalizing payroll.';

export function parseRules(input: unknown): PayrollRules {
  return RulesSchema.parse(input ?? {});
}
