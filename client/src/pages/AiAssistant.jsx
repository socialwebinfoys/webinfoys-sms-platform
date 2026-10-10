// AI assistant (Phase 9).
//
// One page, two tabs, one nav entry:
//
//   Drafts        — the queue of replies waiting for a person. An operator's
//                   daily work, so it is the default tab.
//   Configuration — everything in Part A. Readable by any operator, writable by
//                   an administrator (enforced by the server, not by this page).
//
// Kept as a feature page rather than bolted onto Settings: the queue is an
// operational workflow, not configuration, and the existing Settings page already
// owns Twilio and the sending window. Nothing about the existing settings
// architecture is duplicated — the AI configuration tab is the only place AI
// settings are edited.
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import AiDraftCard from '../components/AiDraftCard';
import AiSettingsForm from '../components/AiSettingsForm';
// Phase 10.
import AiAnalytics from '../components/AiAnalytics';
import AiTestReply from '../components/AiTestReply';
import aiApi from '../services/aiApi';
import { JOB_STATUSES, describeApiError, jobStatusMeta } from '../utils/aiPresentation';

const AiIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3a4 4 0 0 1 4 4v1h1a3 3 0 0 1 0 6h-1v1a4 4 0 0 1-8 0v-1H7a3 3 0 0 1 0-6h1V7a4 4 0 0 1 4-4z" />
    <path d="M12 8v8M9 11h6" />
  </svg>
);

const PAGE_SIZE = 25;

// 'drafted' first: the queue exists for replies that need a decision.
const STATUS_FILTERS = [
  { key: 'drafted', label: 'Awaiting review' },
  { key: '', label: 'All' },
  ...JOB_STATUSES.filter((s) => s !== 'drafted').map((s) => ({
    key: s,
    label: jobStatusMeta(s).label,
  })),
];

export default function AiAssistant() {
  const navigate = useNavigate();

  const [tab, setTab] = useState('drafts');

  // --- shared: AI settings (the queue needs maxReplyCharacters and the
  // configuration tab needs all of it, so it is fetched once here) ------------
  const [settings, setSettings] = useState(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState('');

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError('');
    try {
      setSettings(await aiApi.getSettings());
    } catch (err) {
      setSettingsError(describeApiError(err, { fallback: 'Could not load AI settings.' }).message);
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // --- draft queue ----------------------------------------------------------
  const [jobs, setJobs] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, pages: 0 });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('drafted');
  const [jobsLoading, setJobsLoading] = useState(true);
  const [jobsError, setJobsError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const loadJobs = useCallback(
    async ({ quiet = false } = {}) => {
      if (quiet) setRefreshing(true);
      else setJobsLoading(true);
      setJobsError('');
      try {
        const { jobs: rows, pagination: p } = await aiApi.listJobs({
          status: status || undefined,
          page,
          limit: PAGE_SIZE,
        });
        setJobs(rows);
        if (p) setPagination(p);
      } catch (err) {
        setJobsError(describeApiError(err, { fallback: 'Could not load AI drafts.' }).message);
      } finally {
        setJobsLoading(false);
        setRefreshing(false);
      }
    },
    [status, page]
  );

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // Every action refetches from the server instead of patching local state, so
  // what is on screen is always what the backend actually holds.
  const onJobChanged = useCallback(() => {
    loadJobs({ quiet: true });
  }, [loadJobs]);

  // Deep-link into the existing inbox rather than building a second thread view.
  const openConversation = (conversationId) => {
    if (conversationId) navigate(`/inbox?conversation=${encodeURIComponent(conversationId)}`);
  };

  const maxReplyCharacters = (settings && settings.maxReplyCharacters) || 320;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI assistant</h1>
          <div className="page-sub">
            Replies waiting for review, and how the assistant is configured.
          </div>
        </div>
        <div className="head-actions">
          {settings && (
            <span
              className={settings.enabled ? 'chip chip-on' : 'chip'}
              title={
                settings.enabled
                  ? 'The assistant is processing inbound messages.'
                  : 'The assistant is switched off and will not produce new replies.'
              }
            >
              AI {settings.enabled ? 'enabled' : 'disabled'}
            </span>
          )}
        </div>
      </div>

      {/* Tabs. Native buttons, so keyboard and screen readers work without help. */}
      <div className="ai-tabs" role="tablist" aria-label="AI sections">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'drafts'}
          className={tab === 'drafts' ? 'btn btn-sm ai-tab ai-tab-on' : 'btn btn-sm ai-tab'}
          onClick={() => setTab('drafts')}
        >
          Drafts
          {pagination.total > 0 && status === 'drafted' && (
            <span className="chip" style={{ marginLeft: 8 }}>{pagination.total}</span>
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'analytics'}
          className={tab === 'analytics' ? 'btn btn-sm ai-tab ai-tab-on' : 'btn btn-sm ai-tab'}
          onClick={() => setTab('analytics')}
        >
          Analytics
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'test'}
          className={tab === 'test' ? 'btn btn-sm ai-tab ai-tab-on' : 'btn btn-sm ai-tab'}
          onClick={() => setTab('test')}
        >
          Test Reply
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'config'}
          className={tab === 'config' ? 'btn btn-sm ai-tab ai-tab-on' : 'btn btn-sm ai-tab'}
          onClick={() => setTab('config')}
        >
          Configuration
        </button>
      </div>

      {tab === 'analytics' ? (
        <AiAnalytics onOpenConversation={openConversation} />
      ) : tab === 'test' ? (
        <AiTestReply settings={settings} />
      ) : tab === 'drafts' ? (
        <>
          {/* A disabled assistant explains itself here rather than leaving an
              empty queue looking broken. */}
          {settings && !settings.enabled && (
            <div className="alert alert-info">
              <div>
                The AI assistant is switched off, so no new replies are being prepared. Drafts
                already in the queue can still be reviewed, approved or discarded.
              </div>
            </div>
          )}

          <div className="card">
            <div className="filters">
              <label className="field" style={{ marginBottom: 0 }}>
                <span>Status</span>
                <select
                  className="input input-narrow"
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                >
                  {STATUS_FILTERS.map((f) => (
                    <option key={f.key || 'all'} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => loadJobs({ quiet: true })}
                disabled={refreshing || jobsLoading}
              >
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
              {status && (
                <span className="muted small">
                  {jobStatusMeta(status).description}
                </span>
              )}
            </div>
          </div>

          {jobsError && (
            <div className="alert alert-error" role="alert">
              <div>{jobsError}</div>
              <button type="button" className="btn btn-sm" onClick={() => loadJobs()}>
                Try again
              </button>
            </div>
          )}

          {jobsLoading ? (
            <Spinner label="Loading AI drafts…" />
          ) : jobs.length === 0 && !jobsError ? (
            <div className="card">
              <EmptyState
                icon={AiIcon}
                title={status === 'drafted' ? 'No drafts waiting' : 'Nothing to show'}
                hint={
                  status === 'drafted'
                    ? 'When the assistant writes a reply for review, it appears here newest first.'
                    : 'No AI jobs match this status.'
                }
              />
            </div>
          ) : (
            <>
              <div className="ai-queue">
                {jobs.map((job) => (
                  <AiDraftCard
                    key={job._id}
                    job={job}
                    maxReplyCharacters={maxReplyCharacters}
                    onChanged={onJobChanged}
                    onOpenConversation={openConversation}
                  />
                ))}
              </div>

              {pagination.pages > 1 && (
                <div className="pagination">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Prev
                  </button>
                  <span className="muted small">
                    Page {pagination.page}/{pagination.pages} ({pagination.total})
                  </span>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={page >= pagination.pages}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <AiSettingsForm
          settings={settings}
          onSettings={setSettings}
          loading={settingsLoading}
          loadError={settingsError}
          onReload={loadSettings}
        />
      )}
    </div>
  );
}
