// AI endpoints (Phase 9).
//
// Every AI call the frontend makes, in one place, on top of the EXISTING axios
// instance — so the base URL, the JWT header and the 401 handling in
// services/api.js are inherited rather than reimplemented. No component builds
// its own request.
//
// Nothing here caches, retries or decides anything. The backend is the source of
// truth for AI behaviour; this module only moves data.
//
// An API key travels ONE WAY: in, as an argument to updateSettings. It is never
// returned, never stored in this module, and never written to localStorage or
// sessionStorage — the server only ever hands back { configured, masked }.
import api from './api';

// GET /api/ai/settings → { success, settings }
// `settings.apiKey` is { configured, masked } — never a usable key.
export async function getSettings() {
  const { data } = await api.get('/ai/settings');
  return data.settings;
}

// PUT /api/ai/settings (admin) — partial update: only the keys present in
// `patch` are changed, so a single-field edit cannot blank the rest.
export async function updateSettings(patch) {
  const { data } = await api.put('/ai/settings', patch);
  return data.settings;
}

// POST /api/ai/test (admin, rate-limited) — generates a reply WITHOUT sending.
// Kept here for completeness of the contract; the Test Reply UI is Phase 10.
export async function testReply(message) {
  const { data } = await api.post('/ai/test', { message });
  return data;
}

// GET /api/ai/jobs → { success, data, pagination }
// Supports `status` and `conversation` filters plus page/limit, all validated
// server-side.
export async function listJobs(params = {}) {
  const { data } = await api.get('/ai/jobs', { params });
  return { jobs: data.data || [], pagination: data.pagination || null };
}

// POST /api/ai/jobs/:id/approve
//
// `body` omitted  → send the stored draft exactly as generated.
// `body` supplied → send that text instead, as the human-approved reply.
//
// The job id and the optional body are the ONLY things the server accepts from
// here; recipient, thread, provider and approver are all re-read server-side.
export async function approveJob(jobId, body) {
  const payload = body === undefined || body === null ? {} : { body };
  const { data } = await api.post(`/ai/jobs/${jobId}/approve`, payload);
  return data;
}

// DELETE /api/ai/jobs/:id — discards the draft. Nothing is deleted: the job moves
// to the terminal `rejected` status and is kept for audit.
export async function rejectJob(jobId) {
  const { data } = await api.delete(`/ai/jobs/${jobId}`);
  return data;
}

// GET /api/ai/conversations/:id → { success, conversation, state, jobs }
export async function getConversationAi(conversationId, params = {}) {
  const { data } = await api.get(`/ai/conversations/${conversationId}`, { params });
  return data;
}

// PATCH /api/ai/conversations/:id — { mode: 'draft' | 'auto' }.
// The backend validates strictly; there is no "inherit" value to send.
export async function setConversationMode(conversationId, mode) {
  const { data } = await api.patch(`/ai/conversations/${conversationId}`, { mode });
  return data;
}

// POST / DELETE /api/ai/conversations/:id/takeover
export async function takeOver(conversationId) {
  const { data } = await api.post(`/ai/conversations/${conversationId}/takeover`);
  return data;
}

export async function releaseTakeover(conversationId) {
  const { data } = await api.delete(`/ai/conversations/${conversationId}/takeover`);
  return data;
}

// GET /api/analytics/ai?range=today|7d|30d|all   (Phase 10)
//
// Aggregated server-side. The browser receives summary numbers, never a stream of
// raw log rows to add up itself.
export async function getAnalytics(range) {
  const { data } = await api.get('/analytics/ai', { params: { range } });
  return data;
}

// GET /api/logs?eventPrefix=ai.&...   (Phase 10)
//
// The AI activity table reuses the existing, paginated log endpoint rather than
// adding a second one. `eventPrefix` keeps it to AI events exactly.
export async function listAiEvents(params = {}) {
  const { data } = await api.get('/logs', { params: { eventPrefix: 'ai.', ...params } });
  return { events: data.data || [], pagination: data.pagination || null };
}

export default {
  getSettings,
  updateSettings,
  testReply,
  getAnalytics,
  listAiEvents,
  listJobs,
  approveJob,
  rejectJob,
  getConversationAi,
  setConversationMode,
  takeOver,
  releaseTakeover,
};
