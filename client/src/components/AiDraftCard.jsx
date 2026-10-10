// One AI reply job, with the human review actions (Phase 9).
//
// Used in BOTH the draft queue and the inbox thread, so an operator sees the same
// control in either place and there is one implementation of "approve this".
//
// WHAT IT DOES NOT DO: it never sends an SMS itself, never calls a provider, and
// never decides whether sending is allowed. Every action is one request to the
// existing backend, and the server's response is the only thing that updates the
// UI. A success message is shown only after a 2xx.
//
// The draft text, the contact's name and the stored reason are all UNTRUSTED —
// they come from a model, from an import, or from a customer. They are rendered
// as text children so React escapes them. There is no dangerouslySetInnerHTML
// anywhere in the AI frontend.
import { useState } from 'react';
import ConfirmDialog from './ConfirmDialog';
import SmsCounter from './SmsCounter';
import aiApi from '../services/aiApi';
import {
  jobStatusMeta,
  describeReason,
  describeApiError,
  validateDraftBody,
  formatConfidence,
  jobContactLabel,
} from '../utils/aiPresentation';

export default function AiDraftCard({
  job,
  maxReplyCharacters = 320,
  onChanged,
  onOpenConversation,
  showContact = true,
}) {
  const meta = jobStatusMeta(job.status);
  // The text that would be sent: an approved edit if one was stored, otherwise
  // the generated draft.
  const storedText = job.approvedBody || job.draftReply || '';

  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(storedText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null); // 'approve' | 'reject'

  const { display, name, phone } = jobContactLabel(job);
  const validation = validateDraftBody(text, maxReplyCharacters);

  // Approve, optionally with an edited body. One request; the server re-runs every
  // send guard and remains authoritative about whether anything goes out.
  const doApprove = async (editedBody) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await aiApi.approveJob(job._id, editedBody);
      setConfirm(null);
      setEditing(false);
      setNotice(
        result.result && result.result.simulated
          ? 'Approved. Sending is simulated, so nothing was delivered to the handset.'
          : 'Approved and sent.'
      );
      // The parent refetches from the server rather than trusting local state.
      if (onChanged) onChanged({ action: 'approved', job: result.job, result });
    } catch (err) {
      const described = describeApiError(err, { fallback: 'The draft could not be approved.' });
      setConfirm(null);
      // Say plainly that nothing was sent — that is the first thing an operator
      // needs to know after a failed approval.
      setError(
        described.draftSurvives
          ? `${described.message} Nothing was sent; the draft is still here.`
          : described.message
      );
      // The operator's typed text is never thrown away on a server refusal.
      if (!described.draftSurvives && onChanged) {
        onChanged({ action: 'stale', job: null });
      } else if (described.status === 409 && onChanged) {
        onChanged({ action: 'stale', job: null });
      }
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await aiApi.rejectJob(job._id);
      setConfirm(null);
      setNotice('Draft discarded. Nothing was sent.');
      if (onChanged) onChanged({ action: 'rejected', job: result.job });
    } catch (err) {
      const described = describeApiError(err, { fallback: 'The draft could not be discarded.' });
      setConfirm(null);
      setError(described.message);
      if (described.status === 409 && onChanged) onChanged({ action: 'stale', job: null });
    } finally {
      setBusy(false);
    }
  };

  const conversationId =
    job.conversation && typeof job.conversation === 'object'
      ? job.conversation._id
      : job.conversation;

  return (
    <div className="ai-draft">
      <div className="ai-draft-head">
        <div className="ai-draft-who">
          {showContact && (
            <strong className="small">
              {display}
              {name && phone ? <span className="muted mono small"> · {phone}</span> : null}
            </strong>
          )}
          <div className="chip-row" style={{ marginTop: 4 }}>
            <span className={meta.chipClass} title={meta.description}>
              {meta.label}
            </span>
            {job.edited && (
              <span className="chip" title="A human edited this before it was sent">
                Edited
              </span>
            )}
            {job.escalated && (
              <span className="chip chip-invalid" title="This conversation was handed to a human">
                Escalated
              </span>
            )}
            {/* Shown only when a confidence was actually recorded. A job the
                provider gave no confidence for must not read as "0%". */}
            {formatConfidence(job.confidence) && (
              <span
                className="chip"
                title="How confident the model was in this reply. The backend refuses to auto-send below the configured threshold."
              >
                Confidence {formatConfidence(job.confidence)}
              </span>
            )}
          </div>
        </div>
        <div className="ai-draft-when muted small">
          {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
          {onOpenConversation && conversationId && (
            <div style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onOpenConversation(conversationId)}
              >
                Open conversation
              </button>
            </div>
          )}
        </div>
      </div>

      {/* The reply itself. Untrusted text, rendered as escaped children. */}
      {editing ? (
        <label className="field" style={{ marginBottom: 8 }}>
          <span>Edit the reply before sending</span>
          <textarea
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            aria-describedby={`ai-draft-count-${job._id}`}
            autoFocus
          />
          <div className="composer-bar" id={`ai-draft-count-${job._id}`}>
            <SmsCounter text={text} />
            <span className={validation.ok ? 'muted small' : 'small ai-over-limit'}>
              {text.trim().length}/{maxReplyCharacters}
            </span>
          </div>
          {!validation.ok && text.trim().length > 0 && (
            <div className="muted small ai-over-limit">{validation.reason}</div>
          )}
        </label>
      ) : (
        <div className="ai-draft-body">{storedText || <em className="muted">No text.</em>}</div>
      )}

      {/* Why the backend did not send it, when it did not. */}
      {!meta.actionable && job.reason && (
        <div className="muted small">{describeReason(job.reason)}</div>
      )}
      {job.status === 'failed' && job.lastError && (
        <div className="muted small">Last error: {job.lastError}</div>
      )}

      {error && (
        <div className="alert alert-error" role="alert">
          <div>{error}</div>
        </div>
      )}
      {notice && (
        <div className="alert alert-info" role="status" aria-live="polite">
          <div>{notice}</div>
        </div>
      )}

      {meta.actionable && (
        <div className="ai-draft-actions">
          {editing ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy || !validation.ok}
                onClick={() => setConfirm('approve')}
              >
                {busy ? 'Sending…' : 'Approve edited reply'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  setEditing(false);
                  setText(storedText);
                  setError('');
                }}
              >
                Cancel edit
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={busy}
                onClick={() => setConfirm('approve')}
              >
                {busy ? 'Sending…' : 'Approve & send'}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                onClick={() => {
                  setEditing(true);
                  setText(storedText);
                }}
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={busy}
                onClick={() => setConfirm('reject')}
              >
                Discard
              </button>
            </>
          )}
        </div>
      )}

      {confirm === 'approve' && (
        <ConfirmDialog
          title="Send this reply?"
          confirmLabel="Send"
          danger={false}
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={() => doApprove(editing ? text.trim() : undefined)}
          message={
            <>
              <p>
                This sends an SMS to <strong>{display}</strong>
                {phone ? <span className="mono small"> ({phone})</span> : null}.
              </p>
              {/* Exactly what will go out — escaped, pre-wrapped. */}
              <div className="alert alert-info">
                <div style={{ whiteSpace: 'pre-wrap' }}>{editing ? text.trim() : storedText}</div>
              </div>
              <p className="muted small">
                The server re-checks consent, the line-type policy and the sending window before
                anything is sent.
              </p>
            </>
          }
        />
      )}

      {confirm === 'reject' && (
        <ConfirmDialog
          title="Discard this draft?"
          confirmLabel="Discard draft"
          busy={busy}
          onClose={() => setConfirm(null)}
          onConfirm={doReject}
          message={
            <p>
              The draft is discarded and <strong>no message is sent</strong>. The conversation and
              its history are untouched, and the discarded draft is kept for the audit record.
            </p>
          }
        />
      )}
    </div>
  );
}
