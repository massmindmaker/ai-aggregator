import { describe, expect, it } from 'vitest';
import { payments } from '../payments';

describe('payments top-up refund schema', () => {
  it('maps refund accounting BIGINT columns without losing integer precision', () => {
    const aboveSafeInteger = '9007199254740993';

    for (const column of [
      payments.topupPaidKopecks,
      payments.topupGrantCredits,
      payments.topupRefundedKopecks,
      payments.topupClawedCredits,
      payments.refundClaimKopecks,
    ]) {
      expect(column.mapFromDriverValue(aboveSafeInteger)).toBe(9007199254740993n);
    }
  });
});
