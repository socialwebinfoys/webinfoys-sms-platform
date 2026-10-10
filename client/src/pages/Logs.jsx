// System event log viewer (Phase 8). Read-only, filterable, paginated.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';

const LogsIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

const EVENT_TYPES = [
  'sms.sent',
  'sms.failed',
  'sms.blocked',
  // Phase 1 (compliance)
  'sms.blocked_optout',
  'optout.received',
  'optin.received',
  'automation.stopped_on_reply',
  'automation.run',
  'automation.sent',
  'automation.failed',
  'automation.blocked',
  'following.run',
  'following.sent',
  'following.failed',
  'following.blocked',
  'reply.sent',
  'reply.failed',
  'webhook.inbound',
  // Phase 3 (delivery)
  'delivery.status',
  'delivery.blocked',
  'delivery.unblocked',
  // Phase 4 (inbox)
  'sms.retried',
  'message.deleted',
  'conversation.deleted',
  // Phase 5 (campaigns)
  'campaign.steps_edited',
  'campaign.cloned',
  'campaign.deleted',
  // Phase 6 (import)
  'import.confirmed',
  // Phase 7 (accounts) + Phase 0 (auth)
  'user.updated',
  'auth.login',
  'auth.login_failed',
];

export default function Logs() {
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState('');
  const [severity, setSeverity] = useState('');
  // Phase 7: free-text search and a contact filter.
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [contactId, setContactId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/logs', {
        params: {
          eventType: eventType || undefined,
          severity: severity || undefined,
          search: debouncedSearch || undefined,
          contact: contactId || undefined,
          page,
          limit: 25,
        },
      });
      setRows(data.data);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load logs');
    } finally {
      setLoading(false);
    }
  }, [eventType, severity, debouncedSearch, contactId, page]);

  // Debounced so typing does not fire a request per keystroke.
  useEffect(() => {
    const id = setTimeout(() => { setDebouncedSearch(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const sevClass = (s) =>
    s === 'error' ? 'chip chip-invalid' : s === 'warning' ? 'chip chip-warn' : 'chip';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>System Logs</h1>
          <div className="page-sub">Sends, failures, automation and webhook activity.</div>
        </div>
      </div>

      <div className="filters">
        {/* Phase 7: free-text search over the message, event type and status.
            The term is escaped server-side, so regex characters are literal. */}
        <input
          className="input"
          placeholder="Search events…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <input
          className="input"
          placeholder="Filter by contact id"
          value={contactId}
          onChange={(e) => { setPage(1); setContactId(e.target.value.trim()); }}
        />
        <select
          className="input"
          value={eventType}
          onChange={(e) => {
            setPage(1);
            setEventType(e.target.value);
          }}
        >
          <option value="">All event types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        <select
          className="input"
          value={severity}
          onChange={(e) => {
            setPage(1);
            setSeverity(e.target.value);
          }}
        >
          <option value="">All severities</option>
          <option value="info">info</option>
          <option value="warning">warning</option>
          <option value="error">error</option>
        </select>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Event</th>
              <th>Severity</th>
              <th>Message</th>
              <th>Status</th>
              <th>Related</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6}><Spinner label="Loading events…" /></td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyState
                    icon={LogsIcon}
                    title={eventType || severity ? 'No matching events' : 'No events yet'}
                    hint={
                      eventType || severity
                        ? 'Try clearing the event type or severity filter.'
                        : 'System events (sends, failures, automation and webhook activity) will appear here.'
                    }
                  />
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r._id}>
                  <td className="small">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="mono small">{r.eventType}</td>
                  <td><span className={sevClass(r.severity)}>{r.severity}</span></td>
                  <td className="small">
                    {r.message}
                    {r.error && <div className="muted small">{r.error}</div>}
                  </td>
                  <td className="small">{r.status || <span className="muted">—</span>}</td>
                  <td className="small">
                    {r.contact ? (r.contact.name || r.contact.phone) : ''}
                    {r.campaign ? ` · ${r.campaign.name}` : ''}
                    {r.twilioSid ? <div className="mono muted small">{r.twilioSid}</div> : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="pagination">
        <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
        <span className="muted">Page {pagination.page} of {pagination.pages || 1} ({pagination.total} total)</span>
        <button className="btn btn-sm" disabled={page >= (pagination.pages || 1)} onClick={() => setPage((p) => p + 1)}>Next</button>
      </div>
    </div>
  );
}
