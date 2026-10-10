// SMS Delivery report (Phase 3). Shows what actually reached handsets — based
// on Twilio delivery receipts, not merely "Twilio accepted it" — plus the
// numbers that have been blocked for repeated delivery failures.
import { useEffect, useState, useCallback } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';

const DeliveryIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
  </svg>
);

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

const RANGES = [
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
  { value: 90, label: 'Last 90 days' },
];

export default function Delivery() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [days, setDays] = useState(30);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null); // contact to unblock
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/delivery/report', { params: { days } });
      setReport(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load the delivery report');
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);

  const unblock = async () => {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/delivery/unblock/${confirm._id}`);
      setNotice(`${confirm.name || confirm.phone} can receive messages again.`);
      setConfirm(null);
      load();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to unblock the contact');
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const fmt = (d) => (d ? new Date(d).toLocaleString() : '—');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>SMS Delivery</h1>
          <div className="page-sub">What actually reached handsets, from Twilio delivery receipts.</div>
        </div>
        <select
          className="input"
          style={{ maxWidth: 180 }}
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </div>

      {error && <div className="alert alert-error"><div>{error}</div></div>}
      {notice && <div className="alert alert-info"><div>{notice}</div></div>}

      {loading ? (
        <Spinner label="Loading delivery report…" large />
      ) : !report ? (
        <EmptyState icon={DeliveryIcon} title="No delivery data" hint="Delivery figures appear once Twilio starts reporting receipts." />
      ) : (
        <>
          <div className="stat-grid">
            <StatCard
              label="Delivery rate"
              value={pct(report.deliveryRate, report.totals.delivered + report.totals.undelivered + report.totals.failed)}
              sub="delivered / messages with a receipt"
            />
            <StatCard label="Outbound total" value={report.totals.outbound} sub={`last ${report.days} days`} />
            <StatCard label="Delivered" value={report.totals.delivered} />
            <StatCard label="Awaiting receipt" value={report.totals.awaiting} sub="sent, not yet confirmed" />
            <StatCard label="Undelivered" value={report.totals.undelivered} />
            <StatCard label="Failed" value={report.totals.failed} />
            <StatCard label="Blocked numbers" value={report.totals.blocked} sub="repeated delivery failures" />
          </div>

          {report.totals.awaiting > 0 && report.totals.delivered === 0 && (
            <div className="alert alert-info">
              <div>
                No delivery receipts have arrived yet. Twilio only sends them when{' '}
                <strong>PUBLIC_API_URL</strong> is configured and reachable, and simulated sends
                never produce one.
              </div>
            </div>
          )}

          <div className="analytics-cols">
            <section className="card-block">
              <h3>Status breakdown</h3>
              {Object.keys(report.byStatus).length === 0 ? (
                <div className="muted small">No outbound messages in this period.</div>
              ) : (
                <table className="kv">
                  <tbody>
                    {Object.entries(report.byStatus)
                      .sort((a, b) => b[1] - a[1])
                      .map(([status, n]) => (
                        <tr key={status}>
                          <td className="muted">{status}</td>
                          <td className="mono">{n}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card-block">
              <h3>Top error codes</h3>
              {report.errorCodes.length === 0 ? (
                <div className="muted small">No delivery errors in this period.</div>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>Code</th><th>Count</th><th>Meaning</th></tr>
                    </thead>
                    <tbody>
                      {report.errorCodes.map((e) => (
                        <tr key={e.code}>
                          <td className="mono">{e.code}</td>
                          <td>{e.count}</td>
                          <td className="small">{e.meaning}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="card-block">
            <h3>Recent failures</h3>
            {report.recentFailures.length === 0 ? (
              <div className="muted small">No failed deliveries in this period.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Contact</th><th>Number</th><th>Status</th><th>Error</th><th>Source</th><th>When</th></tr>
                  </thead>
                  <tbody>
                    {report.recentFailures.map((f) => (
                      <tr key={f._id}>
                        <td>{f.contact ? (f.contact.name || f.contact.phone) : <span className="muted">—</span>}</td>
                        <td className="mono small">{f.to}</td>
                        <td><span className="chip chip-invalid">{f.status}</span></td>
                        <td className="small">
                          {f.errorCode ? <span className="mono">{f.errorCode}</span> : <span className="muted">—</span>}
                          {f.meaning && <div className="muted small">{f.meaning}</div>}
                        </td>
                        <td className="small">{f.source || <span className="muted">—</span>}</td>
                        <td className="small">{fmt(f.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card-block">
            <h3>Blocked numbers</h3>
            {report.blockedContacts.length === 0 ? (
              <div className="muted small">No numbers are blocked for delivery failures.</div>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Contact</th><th>Number</th><th>Failures</th><th>Last error</th><th>Blocked</th><th></th></tr>
                  </thead>
                  <tbody>
                    {report.blockedContacts.map((c) => (
                      <tr key={c._id}>
                        <td>{c.name || <span className="muted">—</span>}</td>
                        <td className="mono small">{c.phone}</td>
                        <td>{c.deliveryFailureCount ?? 0}</td>
                        <td className="small">
                          {c.lastDeliveryErrorCode ? <span className="mono">{c.lastDeliveryErrorCode}</span> : <span className="muted">—</span>}
                          {c.lastDeliveryStatus ? <div className="muted small">{c.lastDeliveryStatus}</div> : null}
                        </td>
                        <td className="small">{fmt(c.deliveryBlockedAt)}</td>
                        <td className="row-actions">
                          {isAdmin ? (
                            <button className="btn btn-sm" onClick={() => setConfirm(c)}>Unblock</button>
                          ) : (
                            <span className="muted small">admin only</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {confirm && (
        <ConfirmDialog
          title="Unblock this number?"
          confirmLabel="Unblock"
          danger={false}
          busy={busy}
          onConfirm={unblock}
          onClose={() => setConfirm(null)}
          message={
            <p>
              Allow messages to <strong>{confirm.name || confirm.phone}</strong> again and reset their
              failure count. If the number still cannot receive SMS it will simply be blocked again.
              Opt-out status is not affected.
            </p>
          }
        />
      )}
    </div>
  );
}
