// Contacts page: lookup-status filter, Lookup All progress, and the bulk
// selection behind Delete Selected / Delete All Invalid.
//
// The server owns every decision that matters — which contacts match the
// filters, which numbers are invalid, what gets deleted. The selection here is
// either explicit ids, or "everything matching the current filters" (resolved
// by the server, minus anything unticked), mirroring the Enrollments picker.

// Values the server's ?lookup= accepts. They are buckets of the EXISTING
// Contact.lookup data — the line types Twilio Lookup reports — not new states.
export const LOOKUP_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'landline', label: 'Landline' },
  { value: 'voip', label: 'VoIP' },
  { value: 'tollFree', label: 'Toll-free' },
  { value: 'invalid', label: 'Invalid' },
  { value: 'unknown', label: 'Unknown' },
  { value: 'not_checked', label: 'Not checked' },
];

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export function lookupOptionLabel(option, summary) {
  if (!summary) return option.label;
  const n = option.value ? summary.counts?.[option.value] : summary.total;
  return n === undefined ? option.label : `${option.label} (${fmt(n)})`;
}

// "Total: 120 · Mobile: 87 · …" — real counts from the server.
export function lookupCountsLine(summary) {
  if (!summary) return '';
  const parts = [`Total: ${fmt(summary.total)}`];
  for (const o of LOOKUP_OPTIONS.slice(1)) parts.push(`${o.label}: ${fmt(summary.counts?.[o.value])}`);
  return parts.join(' · ');
}

// --- selection ---------------------------------------------------------------
// { all: false, ids: Set }  — individually ticked contacts (kept across pages)
// { all: true, excluded: Set } — every contact matching the filters, minus unticked
export const emptySelection = () => ({ all: false, ids: new Set(), excluded: new Set() });
export const selectAllMatching = () => ({ all: true, ids: new Set(), excluded: new Set() });

export function isChecked(sel, id) {
  return sel.all ? !sel.excluded.has(id) : sel.ids.has(id);
}

export function toggleContact(sel, id) {
  if (sel.all) {
    const excluded = new Set(sel.excluded);
    if (excluded.has(id)) excluded.delete(id); else excluded.add(id);
    return { ...sel, excluded };
  }
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id); else ids.add(id);
  return { ...sel, ids };
}

export function selectedCount(sel, matchingTotal) {
  return sel.all ? Math.max((matchingTotal || 0) - sel.excluded.size, 0) : sel.ids.size;
}

// The Delete Selected request. Select All sends the FILTERS and the count the
// operator confirmed; the server re-resolves them and refuses if they differ.
export function bulkDeletePayload(sel, filters, matchingTotal) {
  if (sel.all) {
    return {
      selectAll: true,
      filters,
      excludeIds: [...sel.excluded],
      expectedCount: selectedCount(sel, matchingTotal),
    };
  }
  return { ids: [...sel.ids] };
}

export function deleteInvalidPayload(filters, invalidCount) {
  // The server forces lookup=invalid regardless; sent for clarity.
  return { filters: { ...filters, lookup: 'invalid' }, expectedCount: invalidCount };
}

const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

export function deleteSelectedMessage(n) {
  return `Delete ${plural(n, 'contact')}? This cannot be undone.`;
}

export function deleteInvalidMessage(n) {
  return `Delete ${fmt(n)} invalid contact${n === 1 ? '' : 's'}? This cannot be undone.`;
}

// --- Lookup All progress -------------------------------------------------------
export function lookupProgress(job) {
  if (!job || job.status === 'idle') return null;
  const pct = job.total ? Math.round((job.processed / job.total) * 100) : 100;
  const bits = [`${fmt(job.processed)} of ${fmt(job.total)} checked`];
  if (job.results?.invalid) bits.push(`${fmt(job.results.invalid)} invalid`);
  if (job.failed) bits.push(`${fmt(job.failed)} could not be checked`);
  return {
    running: job.status === 'running',
    percent: Math.min(pct, 100),
    text: job.status === 'running'
      ? `Looking up ${job.scope || 'contacts'}… ${bits.join(' · ')}`
      : job.message || bits.join(' · '),
    tone: job.status === 'done' ? 'info' : job.status === 'running' ? 'info' : 'error',
  };
}

// --- requests ------------------------------------------------------------------
export async function fetchLookupSummary(api, params) {
  const { data } = await api.get('/contacts/lookup-summary', { params });
  return data;
}

// Scope = the chosen list, narrowed to the chosen batch ('current',
// 'remaining' or a batch id). The SERVER resolves which contacts that is.
export async function requestLookupAll(api, importId, batch) {
  const body = {};
  if (importId) body.import = importId;
  if (importId && batch) body.batch = batch;
  const { data } = await api.post('/contacts/lookup-all', body);
  return data.job;
}

export async function fetchLookupAllStatus(api) {
  const { data } = await api.get('/contacts/lookup-all/status');
  return data.job;
}

export async function requestBulkDelete(api, body) {
  const { data } = await api.post('/contacts/bulk-delete', body);
  return data;
}

export async function requestDeleteInvalid(api, body) {
  const { data } = await api.post('/contacts/delete-invalid', body);
  return data;
}
