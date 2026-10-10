// AI analytics (Phase 10).
//
// Every number on this screen comes from GET /api/analytics/ai, aggregated in
// MongoDB. Nothing is computed here from raw rows, and nothing is estimated.
//
// Three rules the layout follows, because they are what make an analytics screen
// trustworthy rather than merely impressive:
//
//   1. A measurement that does not exist shows an em dash, not 0. "No confidence
//      was recorded" and "confidence was 0%" mean very different things.
//   2. No metric is drawn as a funnel. Each AI reply attempt ends in exactly one
//      status, so the outcomes are a breakdown, not consecutive stages.
//   3. Nothing is labelled a rate unless the server supplied a denominator for
//      it. Takeovers are shown as counts for exactly this reason.
//
// Charts are the same dependency-free CSS bars the dashboard already uses; no
// chart library is added for this.
import { useCallback, useEffect, useState } from 'react';
import Spinner from './Spinner';
import EmptyState from './EmptyState';
import aiApi from '../services/aiApi';
import {
  ANALYTICS_RANGES,
  rangeLabel,
  formatPercent,
  formatCount,
  formatAverageConfidence,
  eventTypeLabel,
  severityChipClass,
  outcomeBreakdown,
  hasAiActivity,
  confidenceBands,
  describeReason,
  describeApiError,
  jobStatusMeta,
} from '../utils/aiPresentation';

const ChartIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-7" />
  </svg>
);

const EVENTS_PAGE_SIZE = 20;

function StatCard({ label, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub muted small">{sub}</div>}
    </div>
  );
}

// A horizontal bar breakdown. The number is always printed beside the bar, so
// the bar is decoration and the value is the content — readable without colour
// or width perception.
function Bars({ items, empty = 'Nothing recorded in this period.' }) {
  if (!items.length) return <p className="muted small">{empty}</p>;
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <div className="bars">
      {items.map((i) => (
        <div className="bar-row" key={i.label}>
          <span className="bar-label small" title={i.title || undefined}>{i.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(i.value / max) * 100}%` }} />
          </span>
          <span className="bar-val small mono">{formatCount(i.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function AiAnalytics({ onOpenConversation }) {
  const [range, setRange] = useState('7d');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // The activity table, from the existing paginated log endpoint.
  const [events, setEvents] = useState([]);
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsPagination, setEventsPagination] = useState(null);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [eventsError, setEventsError] = useState('');
  const [severity, setSeverity] = useState('');

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (quiet) setRefreshing(true);
      else setLoading(true);
      setError('');
      try {
        setData(await aiApi.getAnalytics(range));
      } catch (err) {
        setError(describeApiError(err, { fallback: 'Could not load AI analytics.' }).message);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [range]
  );

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError('');
    try {
      // The same window the summary uses, so the table and the cards agree.
      const params = { page: eventsPage, limit: EVENTS_PAGE_SIZE };
      if (severity) params.severity = severity;
      if (data && data.rangeStart) params.from = data.rangeStart;
      const { events: rows, pagination } = await aiApi.listAiEvents(params);
      setEvents(rows);
      setEventsPagination(pagination);
    } catch (err) {
      setEventsError(describeApiError(err, { fallback: 'Could not load AI activity.' }).message);
    } finally {
      setEventsLoading(false);
    }
  }, [eventsPage, severity, data && data.rangeStart]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Changing the window resets the table to its first page, so the two never
  // disagree about which period is on screen.
  useEffect(() => {
    setEventsPage(1);
  }, [range, severity]);

  const refresh = () => {
    load({ quiet: true });
    loadEvents();
  };

  if (loading) return <Spinner label="Loading AI analytics…" large />;

  const jobs = (data && data.jobs) || null;
  const confidence = (data && data.confidence) || null;
  const usage = (data && data.usage) || null;
  const handoff = (data && data.handoff) || null;
  const activity = (data && data.activity) || null;
  const avg = formatAverageConfidence(confidence);
  const anyActivity = hasAiActivity(data);

  return (
    <>
      <div className="card ai-analytics-controls">
        <label className="field" style={{ marginBottom: 0 }}>
          <span>Period</span>
          <select
            className="input input-narrow"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            {ANALYTICS_RANGES.map((r) => (
              <option key={r.key} value={r.key}>{r.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm" onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
        {data && data.generatedAt && (
          <span className="muted small" aria-live="polite">
            Generated {new Date(data.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          <div>{error}</div>
          <button type="button" className="btn btn-sm" onClick={() => load()}>Try again</button>
        </div>
      )}

      {!data ? null : !anyActivity ? (
        <div className="card">
          <EmptyState
            icon={ChartIcon}
            title={`No AI activity in this period (${rangeLabel(range)})`}
            hint="Metrics appear here once the assistant has worked on inbound messages. Nothing is estimated, so there is nothing to show yet."
          />
        </div>
      ) : (
        <>
          {/* --- summary cards ------------------------------------------- */}
          <div className="stat-grid">
            <StatCard
              label={`AI reply attempts (${rangeLabel(range)})`}
              value={formatCount(jobs.total)}
              sub={`${formatCount(handoff.conversationsWithAiActivity)} conversation${handoff.conversationsWithAiActivity === 1 ? '' : 's'}`}
            />
            <StatCard
              label="Sent"
              value={formatCount(jobs.sent)}
              sub={`${formatPercent(jobs.sentRate, jobs.total)} of attempts · ${formatCount(jobs.sentApproved)} approved by a person`}
            />
            <StatCard
              label="Awaiting review"
              value={formatCount(jobs.awaitingReview)}
              sub="drafts a person has not acted on"
            />
            <StatCard
              label="Skipped"
              value={formatCount(jobs.byStatus.skipped || 0)}
              sub={`${formatPercent(jobs.skipRate, jobs.total)} of attempts`}
            />
            <StatCard
              label="Escalated"
              value={formatCount(jobs.byStatus.escalated || 0)}
              sub={`${formatPercent(jobs.escalationRate, jobs.total)} of attempts`}
            />
            <StatCard
              label="Failed"
              value={formatCount(jobs.byStatus.failed || 0)}
              sub={`${formatPercent(jobs.failureRate, jobs.total)} of attempts`}
            />
            <StatCard
              label="Worker runs"
              value={formatCount(activity.runs)}
              sub={`${formatCount(activity.providerErrors)} provider error${activity.providerErrors === 1 ? '' : 's'}`}
            />
            <StatCard
              label="Human takeovers"
              value={formatCount(handoff.takeoversEnabled)}
              sub={`${formatCount(handoff.takeoversReleased)} handed back`}
            />
          </div>

          <div className="analytics-cols">
            {/* --- outcomes -------------------------------------------- */}
            <section className="card-block">
              <h3>Outcome of each reply attempt</h3>
              <p className="muted small">
                Every attempt ends in exactly one of these, so the counts add up to{' '}
                {formatCount(jobs.total)}. This is a breakdown, not a funnel — a draft does not
                later become a send within these numbers; it changes which bucket it is in.
              </p>
              <Bars
                items={outcomeBreakdown(jobs).map((row) => ({
                  label: row.label,
                  value: row.value,
                  title: jobStatusMeta(row.status).description,
                }))}
              />
              {jobs.sent > 0 && (
                <p className="muted small">
                  Of {formatCount(jobs.sent)} sent, {formatCount(jobs.sentApproved)} were approved
                  by a person ({formatCount(jobs.edited)} after editing) and{' '}
                  {formatCount(jobs.sentAuto)} were sent automatically.
                </p>
              )}
            </section>

            {/* --- confidence ------------------------------------------ */}
            <section className="card-block">
              <h3>Confidence</h3>
              {confidence.measured === 0 ? (
                <p className="muted small">
                  No confidence values were recorded in this period, so there is nothing to
                  average. This is not the same as a confidence of 0%.
                </p>
              ) : (
                <>
                  <div className="ai-metric-row">
                    <div>
                      <div className="stat-value">{avg.value}</div>
                      <div className="stat-label">Average confidence</div>
                      <div className="muted small">
                        across {formatCount(confidence.measured)} measured attempt
                        {confidence.measured === 1 ? '' : 's'}
                        {confidence.missing > 0 && (
                          <> · {formatCount(confidence.missing)} had none recorded</>
                        )}
                      </div>
                    </div>
                  </div>
                  <p className="muted small">
                    The configured threshold is{' '}
                    <strong>{Math.round(confidence.threshold * 100)}%</strong>:{' '}
                    {formatCount(confidence.atOrAboveThreshold)} at or above it,{' '}
                    {formatCount(confidence.belowThreshold)} below. In auto mode a reply below the
                    threshold is saved as a draft instead of being sent.
                  </p>
                  <Bars items={confidenceBands(confidence)} empty="No distribution to show." />
                </>
              )}
            </section>

            {/* --- tokens ---------------------------------------------- */}
            <section className="card-block">
              <h3>Token usage</h3>
              {usage.jobsWithUsage === 0 ? (
                <p className="muted small">No provider reported token usage in this period.</p>
              ) : (
                <>
                  <Bars
                    items={[
                      { label: 'Prompt (input)', value: usage.promptTokens },
                      { label: 'Completion (output)', value: usage.completionTokens },
                    ]}
                  />
                  <p className="muted small">
                    <strong>{formatCount(usage.totalTokens)}</strong> tokens in total, reported by{' '}
                    {formatCount(usage.jobsWithUsage)} of {formatCount(jobs.total)} attempts
                    {usage.jobsWithoutUsage > 0 && (
                      <> ({formatCount(usage.jobsWithoutUsage)} did not report any)</>
                    )}
                    . No monetary cost is shown: this platform has no provider pricing model, so
                    any figure would be invented.
                  </p>
                </>
              )}
            </section>

            {/* --- reasons --------------------------------------------- */}
            <section className="card-block">
              <h3>Why replies were not sent</h3>
              <Bars
                items={data.reasons.map((r) => ({
                  label: describeReason(r.reason),
                  value: r.n,
                  title: `${jobStatusMeta(r.status).label} — ${r.reason}`,
                }))}
                empty="Every attempt in this period was sent, or is still awaiting review."
              />
            </section>

            {/* --- handoff --------------------------------------------- */}
            <section className="card-block">
              <h3>Human handoff</h3>
              <table className="kv">
                <tbody>
                  <tr>
                    <td className="muted">Takeovers started</td>
                    <td>{formatCount(handoff.takeoversEnabled)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Handed back to AI</td>
                    <td>{formatCount(handoff.takeoversReleased)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Replies escalated by a rule</td>
                    <td>{formatCount(handoff.escalatedJobs)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Conversations with AI activity</td>
                    <td>{formatCount(handoff.conversationsWithAiActivity)}</td>
                  </tr>
                  <tr>
                    <td className="muted">Escalated right now</td>
                    <td>
                      {formatCount(handoff.conversationsEscalatedNow)}{' '}
                      <span className="muted small">(current, not this period)</span>
                    </td>
                  </tr>
                  <tr>
                    <td className="muted">Under takeover right now</td>
                    <td>
                      {formatCount(handoff.conversationsUnderTakeoverNow)}{' '}
                      <span className="muted small">(current, not this period)</span>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p className="muted small">
                No takeover <em>rate</em> is shown. A takeover can be recorded on a conversation
                that had no AI reply attempt in this period, so dividing one by the other would
                compare two different populations.
              </p>
            </section>

            {/* --- event totals ---------------------------------------- */}
            <section className="card-block">
              <h3>AI events in this period</h3>
              <Bars
                items={(activity.byEventType || []).map((e) => ({
                  label: eventTypeLabel(e.eventType),
                  value: e.n,
                  title: e.eventType,
                }))}
                empty="No AI events were logged in this period."
              />
            </section>
          </div>

          {/* Full width, outside the two-column grid: six columns do not fit in a
              grid track, and a table that always scrolls sideways is a table
              nobody reads. */}
          <section className="card-block">
            <h3>Providers and models</h3>
            {data.providers.length === 0 ? (
                <p className="muted small">No provider was recorded in this period.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Provider</th>
                        <th scope="col">Model</th>
                        <th scope="col">Attempts</th>
                        <th scope="col">Sent</th>
                        <th scope="col">Failed</th>
                        <th scope="col">Tokens</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.providers.map((p) => (
                        <tr key={`${p.provider}:${p.model}`}>
                          <td>{p.provider}</td>
                          <td className="mono small">{p.model || <span className="muted">default</span>}</td>
                          <td>{formatCount(p.jobs)}</td>
                          <td>{formatCount(p.sent)}</td>
                          <td>{formatCount(p.failed)}</td>
                          <td className="mono small">
                            {p.totalTokens > 0 ? formatCount(p.totalTokens) : <span className="muted">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="muted small">
                Only providers with recorded activity appear. A configured but unused provider is
                not listed with a zero.
              </p>
            </section>

        </>
      )}

      {/* --- the activity table ----------------------------------------- */}
      <section className="card-block">
        <div className="ai-analytics-controls" style={{ marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>AI activity log</h3>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="sr-only-label">Filter by severity</span>
            <select
              className="input input-narrow"
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              aria-label="Filter AI activity by severity"
            >
              <option value="">All severities</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
            </select>
          </label>
        </div>

        {eventsError && (
          <div className="alert alert-error" role="alert"><div>{eventsError}</div></div>
        )}

        {eventsLoading ? (
          <Spinner label="Loading AI activity…" />
        ) : events.length === 0 ? (
          <p className="muted small">No AI events to show for this period.</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">When</th>
                    <th scope="col">Event</th>
                    <th scope="col">Contact</th>
                    <th scope="col">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e._id}>
                      <td className="small">{new Date(e.createdAt).toLocaleString()}</td>
                      <td>
                        <span className={severityChipClass(e.severity)} title={e.eventType}>
                          {eventTypeLabel(e.eventType)}
                        </span>
                      </td>
                      <td className="small">
                        {e.contact && typeof e.contact === 'object' ? (
                          <>
                            {e.contact.name || <span className="muted">—</span>}
                            {e.contact.phone && (
                              <div className="muted mono small">{e.contact.phone}</div>
                            )}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="small">
                        {/* The server's own summary. Rendered as text, and the
                            server never puts a credential or a message body in it. */}
                        {e.message || <span className="muted">—</span>}
                        {e.meta && e.meta.reason && (
                          <div className="muted small">{describeReason(e.meta.reason)}</div>
                        )}
                        {e.conversation && onOpenConversation && (
                          <div style={{ marginTop: 4 }}>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() =>
                                onOpenConversation(
                                  typeof e.conversation === 'object' ? e.conversation._id : e.conversation
                                )
                              }
                            >
                              Open conversation
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {eventsPagination && eventsPagination.pages > 1 && (
              <div className="pagination">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={eventsPage <= 1}
                  onClick={() => setEventsPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                <span className="muted small">
                  Page {eventsPagination.page}/{eventsPagination.pages} ({eventsPagination.total})
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={eventsPage >= eventsPagination.pages}
                  onClick={() => setEventsPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
