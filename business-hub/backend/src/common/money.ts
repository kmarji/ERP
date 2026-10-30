import { Prisma } from '@prisma/client';

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;
export type DecimalLike = Prisma.Decimal | number | string;

export const d = (v: DecimalLike | null | undefined): Prisma.Decimal => new Prisma.Decimal(v ?? 0);

// JOD has 3 decimals (fils). All ledger amounts are rounded half-up to that precision.
export const money = (v: DecimalLike): Prisma.Decimal => d(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
export const qty = (v: DecimalLike): Prisma.Decimal => d(v).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
export const rate = (v: DecimalLike): Prisma.Decimal => d(v).toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP);
