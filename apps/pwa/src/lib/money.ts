/**
 * Paise in, rupees out. The wire format is integer paise everywhere.
 *
 * There is deliberately no `rupeesToPaise` here. The client never computes a
 * price — it displays what the server sent. A client-side total is a number
 * that can disagree with the invoice, and the customer notices at checkout.
 */
export function formatINR(p: number): string {
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  const rupees = Math.floor(abs / 100);
  const paise = abs % 100;
  // en-IN grouping: 1,20,000 rather than 120,000.
  return `${sign}₹${rupees.toLocaleString('en-IN')}.${String(paise).padStart(2, '0')}`;
}
