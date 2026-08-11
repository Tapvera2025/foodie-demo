import { describe, it, expect } from 'vitest';
import { redact } from './logger.js';

describe('redact() — allow-list, not block-list', () => {
  it('keeps fields that are explicitly loggable', () => {
    const out = redact({ orderId: 'o-1', vendorId: 'v-1', amountPaise: 26840 });
    expect(out).toEqual({ orderId: 'o-1', vendorId: 'v-1', amountPaise: 26840 });
  });

  it('drops PII even though nobody added it to a block-list', () => {
    // PRD SEC-08. This is the whole point: a field nobody thought about is
    // invisible by default rather than leaked by default.
    const out = redact({
      orderId: 'o-1',
      phone: '+919876543210',
      customerName: 'A Person',
      payerReference: 'upi-xyz',
      deviceSecret: 'shhh',
      authorization: 'Bearer abc.def.ghi',
    });
    expect(out).toEqual({ orderId: 'o-1' });
  });

  it('drops a newly invented field until someone opts it in', () => {
    const out = redact({ orderId: 'o-1', someFieldAddedNextTuesday: 'sensitive' });
    expect(out).toEqual({ orderId: 'o-1' });
  });

  it('returns an empty object when nothing is loggable', () => {
    expect(redact({ token: 'x', secret: 'y' })).toEqual({});
  });
});
