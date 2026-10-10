// Analytics dashboard (Phase 8). Renders real aggregate metrics from
// /api/analytics. All values come from the API — no computed/fake numbers here.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';

// Percentage helper that never shows NaN/Infinity: returns '—' when there is no
// valid denominator.
function pct(rate, denom) {
  if (!denom || denom <= 0) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub muted small">{sub}</div>}
    </div>
  );
}

// A simple, dependency-free horizontal bar breakdown.
function Bars({ items }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <span className="bar-label small">{i.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="bar-val small mono">{i.value}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [range, setRange] = useState('all');
  const [overview, setOverview] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data: ov }, { data: ca }] = await Promise.all([
        api.get('/analytics/overview', { params: { range } }),
        api.get('/analytics/campaigns'),
      ]);
      setOverview(ov);
      setCampaigns(ca.data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const rangeLabels = { all: 'All time', today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <div className="page-sub">Delivery, engagement and campaign performance at a glance.</div>
        </div>
        <select
          className="input"
          style={{ maxWidth: 180 }}
          value={range}
          onChange={(e) => setRange(e.target.value)}
        >
          {Object.entries(rangeLabels).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {loading ? (
        <Spinner label="Loading analytics…" large />
      ) : !overview ? (
        <EmptyState title="No analytics available" hint="Metrics will appear here once there is activity to report." />
      ) : (
        <>
          {/* Summary cards */}
          <div className="stat-grid">
            <StatCard label="Contacts" value={overview.contacts.total} sub={`${overview.contacts.active} active · ${overview.contacts.inactive} inactive`} />
            <StatCard label="Campaigns" value={overview.campaigns.total} sub={`${overview.campaigns.active} active · ${overview.campaigns.inactive} inactive`} />
            <StatCard label="Enrollments" value={overview.enrollments.total} sub={`completion ${pct(overview.enrollments.completionRate, overview.enrollments.total)}`} />
            <StatCard label={`Messages (${rangeLabels[range]})`} value={overview.messages.total} sub={`accepted ${pct(overview.messages.acceptedRate ?? overview.messages.deliveryRate, overview.messages.outbound)}`} />
            <StatCard label="Conversations" value={overview.conversations.total} sub={`${overview.conversations.open} open · ${overview.conversations.unreadConversations} unread`} />
            {/* Opt-outs (Phase 1): new ones in the selected range, plus the
                running total of contacts who can no longer be messaged. */}
            <StatCard
              label={`Opt-outs (${rangeLabels[range]})`}
              value={overview.contacts.optedOutInRange ?? 0}
              sub={`${overview.contacts.optedOut ?? 0} opted out in total`}
            />
          </div>

          <div className="analytics-cols">
            {/* Messages */}
            <section className="card-block">
              <h3>Messages ({rangeLabels[range]})</h3>
              <Bars
                items={[
                  { label: 'Inbound', value: overview.messages.inbound },
                  { label: 'Outbound', value: overview.messages.outbound },
                  { label: 'Accepted', value: overview.messages.successfulOutbound },
                  { label: 'Delivered', value: overview.messages.deliveredOutbound ?? 0 },
                  { label: 'Undelivered', value: overview.messages.undeliveredOutbound ?? 0 },
                  { label: 'Failed', value: overview.messages.failedOutbound },
                ]}
              />
              {/* Phase 3 separates the two: 'accepted' means Twilio took the
                  message, 'delivered' means a receipt confirmed it arrived. */}
              <div className="muted small" style={{ marginTop: 8 }}>
                Accepted rate: {pct(overview.messages.acceptedRate ?? overview.messages.deliveryRate, overview.messages.outbound)} (accepted by Twilio / total outbound)
              </div>
              <div className="muted small">
                Delivered rate: {pct(overview.messages.deliveredRate ?? 0, (overview.messages.deliveredOutbound ?? 0) + (overview.messages.undeliveredOutbound ?? 0) + overview.messages.failedOutbound)} (confirmed delivered / messages with a receipt)
                {(overview.messages.awaitingReceipt ?? 0) > 0 && (
                  <> · {overview.messages.awaitingReceipt} awaiting a receipt</>
                )}
              </div>
              {Object.keys(overview.messages.outboundByStatus).length > 0 && (
                <div className="muted small">
                  Outbound status: {Object.entries(overview.messages.outboundByStatus).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                </div>
              )}
            </section>

            {/* Enrollments */}
            <section className="card-block">
              <h3>Enrollments</h3>
              <Bars
                items={[
                  { label: 'Active', value: overview.enrollments.active },
                  { label: 'Completed', value: overview.enrollments.completed },
                  // Stopped because the contact replied (Phase 1).
                  { label: 'Replied', value: overview.enrollments.replied ?? 0 },
                  { label: 'Failed', value: overview.enrollments.failed },
                  { label: 'Paused', value: overview.enrollments.paused },
                  { label: 'Cancelled', value: overview.enrollments.cancelled },
                ]}
              />
              <div className="muted small" style={{ marginTop: 8 }}>
                Completion rate: {pct(overview.enrollments.completionRate, overview.enrollments.total)} (completed / total)
              </div>
            </section>

            {/* Conversations */}
            <section className="card-block">
              <h3>Conversations</h3>
              <Bars
                items={[
                  { label: 'Open', value: overview.conversations.open },
                  { label: 'Closed', value: overview.conversations.closed },
                  { label: 'Unread', value: overview.conversations.unreadConversations },
                  { label: 'Assigned', value: overview.conversations.assigned },
                ]}
              />
              <div className="muted small" style={{ marginTop: 8 }}>
                {overview.conversations.unreadMessages} unread message(s) across {overview.conversations.unreadConversations} conversation(s)
              </div>
            </section>

            {/* Lookup */}
            <section className="card-block">
              <h3>Number Lookup</h3>
              {overview.lookup.lookedUp === 0 ? (
                <div className="muted small">No numbers looked up yet.</div>
              ) : (
                <>
                  <Bars
                    items={[
                      { label: 'Mobile', value: overview.lookup.mobile },
                      { label: 'Landline', value: overview.lookup.landline },
                      { label: 'VoIP', value: overview.lookup.voip },
                      { label: 'Toll-free', value: overview.lookup.tollFree ?? 0 },
                      { label: 'Invalid', value: overview.lookup.invalid },
                    ]}
                  />
                  <div className="muted small" style={{ marginTop: 8 }}>
                    {overview.lookup.lookedUp} looked up · {overview.lookup.valid} valid · {overview.lookup.invalid} invalid
                  </div>
                </>
              )}
            </section>
          </div>

          {/* Campaign table */}
          <section className="card-block">
            <h3>Campaign performance</h3>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Campaign</th>
                    <th>Enrolled</th>
                    <th>Active</th>
                    <th>Completed</th>
                    <th>Failed</th>
                    <th>Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.length === 0 ? (
                    <tr><td colSpan={6} className="muted center">No enrollments yet.</td></tr>
                  ) : (
                    campaigns.map((c) => (
                      <tr key={c.campaignId}>
                        <td>{c.name}</td>
                        <td>{c.total}</td>
                        <td>{c.active}</td>
                        <td>{c.completed}</td>
                        <td>{c.failed}</td>
                        <td>{pct(c.completionRate, c.total)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
