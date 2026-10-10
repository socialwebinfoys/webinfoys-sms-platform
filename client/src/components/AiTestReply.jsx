// Test Reply (Phase 10).
//
// A sandbox: type a hypothetical customer message, see what the configured
// assistant would say. It calls POST /api/ai/test, which generates a reply and
// returns it. That endpoint cannot send — it never touches twilioService, never
// creates an SMSMessage, and never changes a contact or a conversation.
//
// THE UI'S JOB IS TO MAKE THAT OBVIOUS. A generated reply must never be mistaken
// for something a customer received, so it is deliberately NOT styled as a
// message bubble: it is a labelled result panel with a persistent "simulation
// only" statement. The result also echoes the server's own `sent: false`.
//
// The browser never talks to a provider. It calls this API and nothing else; the
// API key stays on the server and is not returned by this endpoint.
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import SmsCounter from './SmsCounter';
import aiApi from '../services/aiApi';
import { describeApiError, formatConfidence, formatCount } from '../utils/aiPresentation';

// A hypothetical inbound SMS. Generous, but bounded so a pathological paste
// cannot be sent to a provider — the server applies its own limits too and
// remains authoritative.
const MAX_MESSAGE = 1000;

export default function AiTestReply({ settings }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  const trimmed = message.trim();
  const tooLong = trimmed.length > MAX_MESSAGE;
  const canSubmit = isAdmin && trimmed.length > 0 && !tooLong && !busy;

  const run = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const data = await aiApi.testReply(trimmed);
      setResult(data);
    } catch (err) {
      const described = describeApiError(err, {
        fallback: 'The test could not be generated.',
      });
      // A 429 is worth explaining rather than just reporting: it is the budget
      // that stops this screen spending provider credit in a loop.
      setError(
        described.status === 429
          ? `${described.message} This screen is rate-limited because each test spends provider credit.`
          : described.message
      );
    } finally {
      setBusy(false);
    }
  };

  const provider = (settings && settings.provider) || '';
  const configured = !!(settings && settings.apiKey && settings.apiKey.configured);

  return (
    <>
      <div className="card">
        <h3>Test the assistant</h3>
        <p className="muted small">
          Type a message as though a customer had sent it and see what the assistant would reply,
          using the persona, business rules and FAQ currently configured.{' '}
          <strong>Nothing is sent.</strong> No SMS leaves the system, no conversation is created or
          changed, and no contact is touched.
        </p>

        {/* State that would make a test fail, said before the attempt. */}
        {!isAdmin && (
          <div className="alert alert-info">
            <div>
              Only an administrator can run a test reply, because each one spends provider credit.
              The server enforces this regardless of what this page shows.
            </div>
          </div>
        )}
        {isAdmin && !provider && (
          <div className="alert alert-info">
            <div>No AI provider is configured yet. Choose one on the Configuration tab first.</div>
          </div>
        )}
        {isAdmin && provider && !configured && (
          <div className="alert alert-info">
            <div>
              No API key is stored for <strong>{provider}</strong>, so a test will fail until one is
              saved on the Configuration tab.
            </div>
          </div>
        )}
        {isAdmin && settings && !settings.enabled && (
          <div className="alert alert-info">
            <div>
              The assistant is switched off. Testing still works — it is a simulation and does not
              depend on the master switch — and running a test does <strong>not</strong> turn it on.
            </div>
          </div>
        )}

        <form onSubmit={run}>
          <label className="field">
            <span>Hypothetical customer message</span>
            <textarea
              rows={3}
              value={message}
              disabled={!isAdmin || busy}
              placeholder="Are you open on Saturday?"
              onChange={(e) => setMessage(e.target.value)}
              aria-describedby="ai-test-count"
              aria-invalid={tooLong ? 'true' : undefined}
            />
            <div className="composer-bar" id="ai-test-count">
              <SmsCounter text={message} />
              <span className={tooLong ? 'small ai-over-limit' : 'muted small'}>
                {trimmed.length}/{MAX_MESSAGE}
              </span>
            </div>
            {tooLong && (
              <span className="small ai-over-limit">
                This message is {trimmed.length - MAX_MESSAGE} characters over the limit. Shorten it
                — nothing is truncated for you.
              </span>
            )}
          </label>

          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              {busy ? 'Generating…' : 'Generate a test reply'}
            </button>
            {(result || error) && (
              <button
                type="button"
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setResult(null);
                  setError('');
                }}
              >
                Clear
              </button>
            )}
          </div>
        </form>

        {error && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 14 }}>
            <div>{error}</div>
          </div>
        )}
      </div>

      {busy && (
        <div className="card">
          <p className="muted small" role="status" aria-live="polite">
            Asking the provider… nothing will be sent to anyone.
          </p>
        </div>
      )}

      {result && (
        <div className="card ai-test-result">
          {/* Impossible to mistake for a real message: a banner, a panel, and the
              server's own sent:false echoed back. */}
          <div className="chip-row">
            <span className="chip chip-warn" title="This reply was generated for inspection only">
              Simulation only
            </span>
            {result.sent === false && (
              <span className="chip chip-on" title="The server confirmed that nothing was sent">
                No SMS was sent
              </span>
            )}
            {result.shouldEscalate && (
              <span className="chip chip-invalid" title="The model asked for a human">
                Would escalate
              </span>
            )}
          </div>

          <h3 style={{ marginTop: 14 }}>What the assistant would reply</h3>
          <div className="ai-draft-body">{result.reply || <em className="muted">No text.</em>}</div>

          <p className="muted small">
            This is a simulation. It was not sent to anyone, no conversation was created or
            changed, and no contact was affected.
          </p>

          <table className="kv">
            <tbody>
              {result.provider && (
                <tr>
                  <td className="muted">Provider</td>
                  <td>{result.provider}</td>
                </tr>
              )}
              {result.model && (
                <tr>
                  <td className="muted">Model</td>
                  <td className="mono small">{result.model}</td>
                </tr>
              )}
              <tr>
                <td className="muted">Confidence</td>
                <td>
                  {formatConfidence(result.confidence) || (
                    <span className="muted">— not reported</span>
                  )}
                  {formatConfidence(result.confidence) && settings && (
                    <span className="muted small">
                      {' '}
                      (threshold {Math.round((settings.confidenceThreshold ?? 0.7) * 100)}%)
                    </span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="muted">Would escalate</td>
                <td>{result.shouldEscalate ? 'Yes' : 'No'}</td>
              </tr>
              {result.reason && (
                <tr>
                  <td className="muted">Model&apos;s reason</td>
                  <td className="small">{result.reason}</td>
                </tr>
              )}
              {result.usage && (
                <tr>
                  <td className="muted">Tokens</td>
                  <td className="small mono">
                    {formatCount(result.usage.promptTokens)} in ·{' '}
                    {formatCount(result.usage.completionTokens)} out ·{' '}
                    {formatCount(result.usage.totalTokens)} total
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <p className="muted small">
            A real inbound message also goes through the guardrails — consent, the line-type policy,
            the sending window, human takeover and the reply limit — which this screen does not
            evaluate. A reply shown here is not a promise that one would be sent.
          </p>
        </div>
      )}
    </>
  );
}
