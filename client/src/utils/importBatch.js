// Batch allocation from an imported list — the client-side rules.
//
// The server owns the queue (which contacts remain, and taking the next N
// atomically); nothing here slices arrays of contacts. This only validates
// what the operator typed, describes the outcome before they commit, and
// shapes the two requests.

export const formatCount = (n) => Number(n || 0).toLocaleString('en-US');

// What was typed into the Custom box, checked the same way the server checks
// it. Returns { ok, value } or { ok: false, error }.
export function validateCustomCount(raw, remaining) {
  const text = String(raw ?? '').trim();
  if (remaining <= 0) return { ok: false, error: 'Every contact in this list has already been allocated.' };
  if (text === '') return { ok: false, error: 'Enter how many contacts to use.' };
  if (/^-/.test(text)) return { ok: false, error: 'The number of contacts must be greater than 0.' };
  if (/^\d+[.,]\d*$/.test(text) || /^[.,]\d+$/.test(text)) {
    return { ok: false, error: 'Whole numbers only — no decimals.' };
  }
  if (!/^\d+$/.test(text)) return { ok: false, error: 'Enter a whole number.' };
  const value = Number(text);
  if (value <= 0) return { ok: false, error: 'The number of contacts must be greater than 0.' };
  if (value > remaining) {
    return {
      ok: false,
      error: `Only ${formatCount(remaining)} contact${remaining === 1 ? '' : 's'} remain in this list.`,
    };
  }
  return { ok: true, value };
}

// How many contacts the current choice would take, or null if it is invalid.
export function batchSize(mode, raw, remaining) {
  if (remaining <= 0) return null;
  if (mode === 'all') return remaining;
  const v = validateCustomCount(raw, remaining);
  return v.ok ? v.value : null;
}

// "500 contacts will be used and 8,700 will remain."
export function describeBatch(size, remaining) {
  const left = remaining - size;
  return `${formatCount(size)} contact${size === 1 ? '' : 's'} will be used and ${formatCount(left)} will remain.`;
}

// The confirmation after an allocation. Names the batch and its persisted size
// — not row positions, which say nothing about which contacts it holds.
export function allocationNotice(res) {
  const b = res.batch;
  let msg = `Batch ${b.number} allocated: ${formatCount(b.size)} contact${b.size === 1 ? '' : 's'}. ${formatCount(res.data.remaining)} remain.`;
  if (res.enrollment) {
    msg += ` Enrolled ${formatCount(res.enrollment.enrolled)} from this batch only`;
    const extra = [];
    if (res.enrollment.skipped) extra.push(`${formatCount(res.enrollment.skipped)} already enrolled`);
    if (res.enrollment.notEligible) extra.push(`${formatCount(res.enrollment.notEligible)} not eligible`);
    if (res.enrollment.failed) extra.push(`${formatCount(res.enrollment.failed)} failed`);
    msg += extra.length ? ` (${extra.join(', ')}).` : '.';
  }
  return msg;
}

// The Contacts page's batch view → the `batch` query parameter.
//   'all' -> none (every contact of the list), 'current', 'remaining', or a batch id.
export function batchQueryParam(view) {
  return view && view !== 'all' ? view : undefined;
}

export function allocationPayload(mode, raw, campaignId) {
  const body = mode === 'all' ? { mode: 'all' } : { mode: 'custom', count: Number(String(raw).trim()) };
  if (campaignId) body.campaignId = campaignId;
  return body;
}

// --- batches as a selectable scope (Contacts, Campaigns, Enrollments) --------

// The batches an operator can pick: allocated and not deleted.
export function selectableBatches(allocation) {
  return ((allocation && allocation.batches) || []).filter((b) => b.status === 'complete');
}

// "Batch 2 — 100 contacts" — the LIVE member count when the server sends it.
export function batchOptionLabel(b) {
  const n = b.contacts ?? b.size ?? 0;
  return `Batch ${b.number} — ${formatCount(n)} contact${n === 1 ? '' : 's'}`;
}

export const NO_BATCHES_MESSAGE = 'No batches available. Create a batch from Contacts first.';

export function deleteBatchMessage(number) {
  return `Delete Batch ${number}? This will remove the batch allocation/grouping. This action cannot be undone.`;
}

export async function requestDeleteBatch(api, importId, batchId) {
  const { data } = await api.delete(`/contact-imports/${importId}/batches/${batchId}`);
  return data;
}

export async function fetchAllocation(api, importId) {
  const { data } = await api.get(`/contact-imports/${importId}/allocation`);
  return data.data;
}

export async function requestAllocation(api, importId, body) {
  const { data } = await api.post(`/contact-imports/${importId}/allocate`, body);
  return data;
}
