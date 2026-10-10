// AI controls for one conversation, inside the existing inbox side panel
// (Phase 9, Parts C, F and G).
//
// Three things an operator needs while working a thread:
//   1. what the assistant's state is here, including the states that mean it will
//      NOT reply (takeover, escalated, reply limit reached, AI off);
//   2. take over / hand back;
//   3. this conversation's mode, draft or auto.
//
// Plus any draft waiting on this thread, reviewed with the same component the
// queue uses.
//
// NO TIMER OF ITS OWN. The inbox already polls on one interval with a lock; adding
// a second would double the request rate for the same screen. This fetches when
// the conversation changes and after an action it performed, and otherwise refetches
// only when the inbox tells it something moved.
import { useCallback, useEffect, useState } from 'react';
import AiDraftCard from './AiDraftCard';
import aiApi from '../services/aiApi';
import {
  conversationAiChips,
  describeApiError,
  describeReason,
  effectiveMode,
  replyLimitReached,
  jobStatusMeta,
} from '../utils/aiPresentation';

export default function AiConversationPanel({
  conversationId,
  aiSettings,
  refreshToken,
  onConversationChanged,
}) {
  const [state, setState] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');  // 'takeover' | 'release' | 'mode'
  const [notice, setNotice] = useState('');

  const load = useCallback(
    async ({ quiet = false } = {}) => {
      if (!conversationId) return;
      if (!quiet) setLoading(true);
      setError('');
      try {
        const data = await aiApi.getConversationAi(conversationId, { limit: 5 });
        setState(data.state || null);
        setJobs(data.jobs || []);
      } catch (err) {
        setError(describeApiError(err, { fallback: 'Could not load the AI state.' }).message);
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [conversationId]
  );

  // Reset and reload whenever the thread changes, so state from the previous
  // conversation can never linger on screen.
  useEffect(() => {
    setState(null);
    setJobs([]);
    setNotice('');
    load();
  }, [load]);

  // The inbox bumps refreshToken when its own poll saw a change; piggy-backing on
  // that avoids a second interval for the same data.
  useEffect(() => {
    if (refreshToken) load({ quiet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  if (!conversationId) return null;

  // The panel reads the per-thread state from /api/ai/conversations/:id, which is
  // the authoritative shape. conversationAiChips wants a conversation-like object.
  const conversationLike = { ai: state || {} };
  const chips = conversationAiChips(aiSettings, conversationLike);
  const { mode, inherited } = effectiveMode(aiSettings, conversationLike);
  const limitReached = replyLimitReached(aiSettings, conversationLike);
  const takeover = !!(state && state.takeover);

  const run = async (action, fn, successMessage) => {
    if (busy) return; // one AI action at a time; prevents a double click
    setBusy(action);
    setError('');
    setNotice('');
    try {
      await fn();
      // The server is authoritative: refetch rather than assuming the result.
      await load({ quiet: true });
      if (onConversationChanged) onConversationChanged();
      setNotice(successMessage);
    } catch (err) {
      setError(describeApiError(err, { fallback: 'That did not work.' }).message);
      // Even on failure, resync — the real state may have moved underneath.
      await load({ quiet: true });
    } finally {
      setBusy('');
    }
  };

  const changeMode = (next) =>
    run(
      'mode',
      () => aiApi.setConversationMode(conversationId, next),
      next === 'auto'
        ? 'This conversation is in auto mode. The assistant may reply itself when every safety check passes.'
        : 'This conversation is in draft mode. Replies wait for a person.'
    );

  const actionableJobs = jobs.filter((j) => jobStatusMeta(j.status).actionable);
  const recentJobs = jobs.filter((j) => !jobStatusMeta(j.status).actionable).slice(0, 3);

  return (
    <div className="ai-panel">
      <h3>AI assistant</h3>

      {loading ? (
        <p className="muted small">Loading AI state…</p>
      ) : (
        <>
          <div className="chip-row">
            {chips.map((c) => (
              <span key={c.key} className={c.chipClass} title={c.title}>
                {c.label}
              </span>
            ))}
          </div>

          {/* Part G: say plainly when the backend will refuse to let AI reply,
              rather than showing a hopeful "active" state. */}
          {limitReached && aiSettings && aiSettings.enabled && (
            <div className="alert alert-info" style={{ marginTop: 10 }}>
              <div>
                AI reply limit reached for this conversation ({state.replyCount} of{' '}
                {aiSettings.maxRepliesPerConversation}). The assistant will not send more replies
                here. Handing the thread back does not reset the count — reply yourself, or raise
                the limit in the AI configuration.
              </div>
            </div>
          )}

          {state && state.escalated && (
            <div className="alert alert-info" style={{ marginTop: 10 }}>
              <div>
                Escalated to a human
                {state.escalationReason ? <> — {describeReason(state.escalationReason)}</> : null}.
                {state.escalatedAt && (
                  <div className="muted small">{new Date(state.escalatedAt).toLocaleString()}</div>
                )}
                <div className="muted small">
                  Handing the thread back to the assistant clears this.
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="alert alert-error" role="alert" style={{ marginTop: 10 }}>
              <div>{error}</div>
            </div>
          )}
          {notice && (
            <div className="alert alert-info" role="status" aria-live="polite" style={{ marginTop: 10 }}>
              <div>{notice}</div>
            </div>
          )}

          {/* --- C2 / C3: takeover --------------------------------------- */}
          <div className="panel-row">
            <div>
              <strong className="small">Who is answering</strong>
              <div className="muted small">
                {takeover
                  ? 'You have taken over. The assistant will not reply to this conversation.'
                  : 'The assistant may work on this conversation, subject to its mode and the safety checks.'}
              </div>
              {takeover && state.takeoverAt && (
                <div className="muted small">
                  Since {new Date(state.takeoverAt).toLocaleString()}
                </div>
              )}
            </div>
            <div className="row-actions">
              {takeover ? (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      'release',
                      () => aiApi.releaseTakeover(conversationId),
                      'Handed back to the assistant.'
                    )
                  }
                >
                  {busy === 'release' ? 'Working…' : 'Hand back to AI'}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      'takeover',
                      () => aiApi.takeOver(conversationId),
                      'You have taken over. The assistant will not reply here.'
                    )
                  }
                >
                  {busy === 'takeover' ? 'Working…' : 'Take over'}
                </button>
              )}
            </div>
          </div>

          {/* --- Part F: per-conversation mode --------------------------- */}
          <div className="panel-row">
            <div>
              <strong className="small">Mode for this conversation</strong>
              <div className="muted small">
                {inherited
                  ? `Following the platform default (${mode}).`
                  : `Set to ${mode} for this conversation.`}
              </div>
            </div>
            <div className="row-actions">
              <button
                type="button"
                className={mode === 'draft' && !inherited ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                disabled={!!busy}
                aria-pressed={mode === 'draft'}
                onClick={() => changeMode('draft')}
              >
                Draft
              </button>
              <button
                type="button"
                className={mode === 'auto' && !inherited ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
                disabled={!!busy}
                aria-pressed={mode === 'auto'}
                onClick={() => changeMode('auto')}
              >
                Auto
              </button>
            </div>
          </div>
          {busy === 'mode' && <div className="muted small">Saving the mode…</div>}

          {/* --- drafts on this thread ----------------------------------- */}
          {actionableJobs.length > 0 && (
            <>
              <h3>Waiting for review</h3>
              {actionableJobs.map((job) => (
                <AiDraftCard
                  key={job._id}
                  job={job}
                  showContact={false}
                  maxReplyCharacters={(aiSettings && aiSettings.maxReplyCharacters) || 320}
                  onChanged={async () => {
                    await load({ quiet: true });
                    if (onConversationChanged) onConversationChanged();
                  }}
                />
              ))}
            </>
          )}

          {recentJobs.length > 0 && (
            <>
              <h3>Recent AI activity</h3>
              {recentJobs.map((job) => {
                const meta = jobStatusMeta(job.status);
                return (
                  <div className="panel-row" key={job._id}>
                    <div>
                      <span className={meta.chipClass} title={meta.description}>
                        {meta.label}
                      </span>
                      {job.reason && (
                        <div className="muted small">{describeReason(job.reason)}</div>
                      )}
                    </div>
                    <div className="muted small">
                      {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {jobs.length === 0 && (
            <p className="muted small">The assistant has not worked on this conversation yet.</p>
          )}
        </>
      )}
    </div>
  );
}
