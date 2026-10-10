// AI configuration (Phase 9, Part A).
//
// Two deliberately separate things on one screen:
//
//   1. ACTIVATION — the master switch, with its own control and its own
//      confirmation. Changing it is a decision about whether the assistant runs.
//   2. CONFIGURATION — everything else, behind one Save. Editing a persona is not
//      a decision about whether anything runs, and the two must not look alike.
//
// Part B asks for exactly that separation: "Enable AI" must not read like "send
// SMS now". Enabling the assistant does not send anything — the first thing it
// does in the default draft mode is write a reply for a human to look at.
//
// The server is authoritative throughout. Local state is a draft of a form; after
// every successful save the state is replaced with what the server returned, so
// the screen can never show an unsaved value as saved.
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import ConfirmDialog from './ConfirmDialog';
import Spinner from './Spinner';
import aiApi from '../services/aiApi';
import { describeApiError } from '../utils/aiPresentation';

// Mirrors the server's own validation (aiController.updateAiSettings) so a bad
// value is caught before a round trip. The server re-validates and wins.
const NUMERIC_FIELDS = [
  {
    key: 'confidenceThreshold',
    label: 'Confidence threshold',
    min: 0,
    max: 1,
    step: 0.05,
    integer: false,
    hint: 'In auto mode, a reply the model is less confident about than this is saved as a draft instead of being sent.',
  },
  {
    key: 'maxRepliesPerConversation',
    label: 'Max AI replies per conversation',
    min: 0,
    max: 100,
    step: 1,
    integer: true,
    hint: 'A hard stop on back-and-forth. Once reached the assistant stops replying to that conversation, and releasing a takeover does not reset the count.',
  },
  {
    key: 'contextMessageLimit',
    label: 'Messages of context',
    min: 1,
    max: 50,
    step: 1,
    integer: true,
    hint: 'How many recent messages from the conversation are given to the model.',
  },
  {
    key: 'maxReplyCharacters',
    label: 'Max reply length',
    min: 20,
    max: 1600,
    step: 10,
    integer: true,
    hint: 'A longer reply is refused rather than cut short. Also the limit applied to a reply you edit by hand.',
  },
];

const EMPTY_FORM = {
  defaultMode: 'draft',
  autoTakeoverOnManualReply: true,
  provider: '',
  model: '',
  persona: '',
  businessRules: '',
  faq: '',
  escalationKeywords: [],
  confidenceThreshold: 0.7,
  maxRepliesPerConversation: 3,
  contextMessageLimit: 10,
  maxReplyCharacters: 320,
};

function formFromSettings(settings) {
  return {
    defaultMode: settings.defaultMode || 'draft',
    // Fix 2. Absent means on, matching how the server reads it.
    autoTakeoverOnManualReply: settings.autoTakeoverOnManualReply !== false,
    provider: settings.provider || '',
    model: settings.model || '',
    persona: settings.persona || '',
    businessRules: settings.businessRules || '',
    faq: settings.faq || '',
    escalationKeywords: [...(settings.escalationKeywords || [])],
    confidenceThreshold: settings.confidenceThreshold ?? 0.7,
    maxRepliesPerConversation: settings.maxRepliesPerConversation ?? 3,
    contextMessageLimit: settings.contextMessageLimit ?? 10,
    maxReplyCharacters: settings.maxReplyCharacters ?? 320,
  };
}

export default function AiSettingsForm({ settings, onSettings, loading, loadError, onReload }) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // Seeded from the server's values on the FIRST render, not in an effect. An
  // effect runs after the first paint, which would show the schema defaults for a
  // frame and — worse — make the form read as dirty before anyone touched it.
  const [form, setForm] = useState(() => (settings ? formFromSettings(settings) : EMPTY_FORM));
  const [keyInput, setKeyInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [saving, setSaving] = useState(false);
  const [togglingAi, setTogglingAi] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [confirmClearKey, setConfirmClearKey] = useState(false);

  // Re-seed whenever the server hands over a new version of the truth — after a
  // save, or when settings arrive for a form that first rendered without them.
  useEffect(() => {
    if (settings) setForm(formFromSettings(settings));
  }, [settings]);

  const providers = useMemo(
    () => (settings && settings.availableProviders) || [],
    [settings]
  );

  const dirty = useMemo(() => {
    if (!settings) return false;
    const current = formFromSettings(settings);
    return (
      JSON.stringify({ ...current, escalationKeywords: [...current.escalationKeywords].sort() }) !==
        JSON.stringify({ ...form, escalationKeywords: [...form.escalationKeywords].sort() }) ||
      keyInput.trim().length > 0
    );
  }, [settings, form, keyInput]);

  if (loading) return <Spinner label="Loading AI configuration…" />;
  if (loadError && !settings) {
    return (
      <div className="card">
        <div className="alert alert-error" role="alert">
          <div>{loadError}</div>
        </div>
        <button type="button" className="btn" onClick={onReload}>
          Try again
        </button>
      </div>
    );
  }
  if (!settings) return null;

  const set = (key, value) => {
    setForm((f) => ({ ...f, [key]: value }));
    setNotice('');
    setFieldErrors((e) => {
      if (!e[key]) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  };

  // --- activation (separate from Save) --------------------------------------
  const toggleAi = async () => {
    setTogglingAi(true);
    setError('');
    setNotice('');
    try {
      const fresh = await aiApi.updateSettings({ enabled: !settings.enabled });
      onSettings(fresh);
      setConfirmToggle(false);
      setNotice(
        fresh.enabled
          ? 'The AI assistant is on. In draft mode it writes replies for review and sends nothing by itself.'
          : 'The AI assistant is off. It will not process new replies. Drafts already waiting for review are untouched.'
      );
    } catch (err) {
      setConfirmToggle(false);
      setError(describeApiError(err, { fallback: 'Could not change the AI state.' }).message);
    } finally {
      setTogglingAi(false);
    }
  };

  // --- configuration save ---------------------------------------------------
  const validate = () => {
    const errors = {};
    for (const f of NUMERIC_FIELDS) {
      const raw = form[f.key];
      const value = Number(raw);
      if (raw === '' || !Number.isFinite(value)) {
        errors[f.key] = 'Enter a number.';
      } else if (value < f.min || value > f.max) {
        errors[f.key] = `Must be between ${f.min} and ${f.max}.`;
      } else if (f.integer && !Number.isInteger(value)) {
        errors[f.key] = 'Must be a whole number.';
      }
    }
    if (form.provider && !providers.includes(form.provider)) {
      errors.provider = 'Choose a supported provider.';
    }
    return errors;
  };

  const save = async (e) => {
    if (e) e.preventDefault();
    if (saving) return; // no duplicate submissions
    setError('');
    setNotice('');

    const errors = validate();
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      setError('Some values need fixing before this can be saved.');
      return;
    }
    setFieldErrors({});

    // Only the fields this form owns. `enabled` is deliberately absent — it has
    // its own control, so saving configuration can never switch the AI on.
    const patch = {
      defaultMode: form.defaultMode,
      autoTakeoverOnManualReply: form.autoTakeoverOnManualReply,
      model: String(form.model).trim(),
      persona: form.persona,
      businessRules: form.businessRules,
      faq: form.faq,
      escalationKeywords: form.escalationKeywords,
      confidenceThreshold: Number(form.confidenceThreshold),
      maxRepliesPerConversation: Number(form.maxRepliesPerConversation),
      contextMessageLimit: Number(form.contextMessageLimit),
      maxReplyCharacters: Number(form.maxReplyCharacters),
    };
    if (form.provider) patch.provider = form.provider;
    // The key is write-only and only sent when something was typed. An untouched
    // field leaves the stored key exactly as it is.
    const typedKey = keyInput.trim();
    if (typedKey) patch.apiKey = typedKey;

    setSaving(true);
    try {
      const fresh = await aiApi.updateSettings(patch);
      onSettings(fresh);
      // Cleared immediately on success so the secret does not sit in a DOM node
      // for the rest of the session.
      setKeyInput('');
      setNotice('AI configuration saved.');
    } catch (err) {
      const described = describeApiError(err, { fallback: 'Could not save the AI configuration.' });
      // Nothing is marked as saved and the typed values are kept, so the operator
      // can correct and retry rather than lose their work.
      setError(described.message);
    } finally {
      setSaving(false);
    }
  };

  const clearKey = async () => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const fresh = await aiApi.updateSettings({ apiKey: '' });
      onSettings(fresh);
      setKeyInput('');
      setConfirmClearKey(false);
      setNotice('The stored API key was removed.');
    } catch (err) {
      setConfirmClearKey(false);
      setError(describeApiError(err, { fallback: 'Could not remove the stored key.' }).message);
    } finally {
      setSaving(false);
    }
  };

  const addKeyword = () => {
    const value = keyword.trim().toLowerCase();
    if (!value) return;
    if (form.escalationKeywords.includes(value)) {
      setKeyword('');
      return; // already present — no duplicates
    }
    set('escalationKeywords', [...form.escalationKeywords, value]);
    setKeyword('');
  };

  const removeKeyword = (value) =>
    set(
      'escalationKeywords',
      form.escalationKeywords.filter((k) => k !== value)
    );

  const apiKey = settings.apiKey || { configured: false, masked: '' };
  const readOnly = !isAdmin;

  return (
    <>
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

      {/* ---- A1: activation, on its own ---------------------------------- */}
      <div className="card">
        <h3>AI assistant</h3>
        <div className="ai-master">
          <div>
            <div className="chip-row">
              <span
                className={settings.enabled ? 'chip chip-on' : 'chip'}
                title={
                  settings.enabled
                    ? 'The assistant processes inbound messages.'
                    : 'The assistant processes nothing.'
                }
              >
                {settings.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <span className="chip" title="What happens to a reply once it is written">
                {settings.defaultMode === 'auto' ? 'Auto mode' : 'Draft mode'}
              </span>
            </div>
            <p className="muted small" style={{ marginTop: 10, marginBottom: 0 }}>
              {settings.enabled ? (
                <>
                  The assistant reads inbound messages and prepares a reply.
                  {settings.defaultMode === 'auto'
                    ? ' In auto mode it may also send that reply itself — only when every backend safety check passes.'
                    : ' In draft mode it sends nothing: a person approves each reply.'}
                </>
              ) : (
                <>
                  The assistant is off and will <strong>not</strong> process new replies. Drafts
                  already waiting for review stay where they are and can still be approved or
                  discarded. Switching this on does not send anything by itself.
                </>
              )}
            </p>
          </div>
          <div>
            <button
              type="button"
              className={settings.enabled ? 'btn btn-danger' : 'btn btn-primary'}
              disabled={readOnly || togglingAi}
              onClick={() => setConfirmToggle(true)}
              title={readOnly ? 'Only an administrator can change this' : undefined}
            >
              {togglingAi ? 'Working…' : settings.enabled ? 'Turn AI off' : 'Turn AI on'}
            </button>
            {readOnly && <div className="muted small">Administrators only</div>}
          </div>
        </div>
      </div>

      <form onSubmit={save}>
        {/* ---- A2: mode ------------------------------------------------- */}
        <div className="card">
          <h3>What happens to a generated reply</h3>
          <div className="ai-mode-choices" role="radiogroup" aria-label="Default AI mode">
            {[
              {
                value: 'draft',
                title: 'Draft — a person approves every reply',
                hint: 'The assistant writes a reply and puts it in the draft queue. Nothing is sent until someone approves it. This is the safe default.',
              },
              {
                value: 'auto',
                title: 'Auto — the assistant may send replies itself',
                hint: 'A reply is sent automatically, but only if every backend guardrail passes: consent, the line-type policy, the sending window, no human takeover, the reply limit and the confidence threshold. Anything that fails becomes a draft instead.',
              },
            ].map((option) => (
              <label className="checkbox-field" key={option.value}>
                <input
                  type="radio"
                  name="defaultMode"
                  value={option.value}
                  checked={form.defaultMode === option.value}
                  disabled={readOnly}
                  onChange={() => set('defaultMode', option.value)}
                />
                <span>
                  {option.title}
                  <div className="muted small">{option.hint}</div>
                </span>
              </label>
            ))}
          </div>
          <p className="muted small">
            This is the platform default. A single conversation can be set to the other mode from
            the inbox.
          </p>

          {/* Fix 2: the one setting that governs what happens when a person
              answers a thread the assistant is working on. */}
          <label className="checkbox-field" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={form.autoTakeoverOnManualReply}
              disabled={readOnly}
              onChange={(e) => set('autoTakeoverOnManualReply', e.target.checked)}
            />
            <span>
              Pause AI in a chat when a human replies
              <div className="muted small">
                When you answer a conversation yourself, it is handed to you and the assistant
                stops working on it until you hand it back. Replies it had already queued or
                drafted for that conversation are cancelled <strong>either way</strong> — that is
                what stops a customer receiving two different answers, so it is not optional.
              </div>
            </span>
          </label>
        </div>

        {/* ---- A3/A4/A5: provider, model, key --------------------------- */}
        <div className="card">
          <h3>Provider</h3>
          <div className="ai-grid">
            <label className="field">
              <span>Provider</span>
              <select
                className="input"
                value={form.provider}
                disabled={readOnly}
                onChange={(e) => set('provider', e.target.value)}
              >
                <option value="">Select a provider…</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              {fieldErrors.provider && (
                <span className="small ai-over-limit">{fieldErrors.provider}</span>
              )}
              <span className="muted small">
                The providers this installation supports. Adding another is a backend change.
              </span>
            </label>

            <label className="field">
              <span>Model</span>
              <input
                value={form.model}
                disabled={readOnly}
                placeholder={settings.defaultModelForProvider || 'provider default'}
                onChange={(e) => set('model', e.target.value)}
              />
              <span className="muted small">
                Any model name the provider accepts — this is a free text field, not a fixed list.
                Leave it blank to use
                {settings.defaultModelForProvider ? (
                  <>
                    {' '}
                    the default (<code className="mono">{settings.defaultModelForProvider}</code>).
                  </>
                ) : (
                  <> the provider default.</>
                )}
              </span>
            </label>
          </div>

          <label className="field">
            <span>API key</span>
            <div className="chip-row" style={{ marginBottom: 8 }}>
              {apiKey.configured ? (
                <span className="chip chip-on" title="A key is stored, encrypted">
                  API key is configured
                </span>
              ) : (
                <span className="chip chip-warn">No API key stored</span>
              )}
              {apiKey.configured && apiKey.masked && (
                <span className="chip mono" title="The last four characters, so two keys can be told apart">
                  {apiKey.masked}
                </span>
              )}
              {apiKey.unreadable && (
                <span className="chip chip-invalid" title="Stored, but it cannot be decrypted with the current AI_ENCRYPTION_KEY">
                  Stored key unreadable — re-enter it
                </span>
              )}
            </div>
            <input
              type="password"
              autoComplete="new-password"
              value={keyInput}
              disabled={readOnly || settings.encryptionConfigured === false}
              placeholder={apiKey.configured ? 'Enter a new key to replace the stored one' : 'Paste the provider API key'}
              onChange={(e) => setKeyInput(e.target.value)}
            />
            <span className="muted small">
              The stored key is never shown or sent back to this page — only whether one exists and
              its last four characters. Leave this blank to keep the current key.
            </span>
            {settings.encryptionConfigured === false && (
              <div className="alert alert-error" role="alert" style={{ marginTop: 10 }}>
                <div>
                  The server has no <code className="mono">AI_ENCRYPTION_KEY</code> configured, so a
                  key cannot be stored securely and saving one will be refused. Set it in the
                  server environment first.
                </div>
              </div>
            )}
            {apiKey.configured && !readOnly && (
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                style={{ marginTop: 10 }}
                disabled={saving}
                onClick={() => setConfirmClearKey(true)}
              >
                Remove stored key
              </button>
            )}
          </label>
        </div>

        {/* ---- A6/A7/A8: persona, rules, FAQ ---------------------------- */}
        <div className="card">
          <h3>How the assistant should answer</h3>
          <p className="muted small">
            These three are sent to the model as instructions. They are plain text — the platform
            does not interpret or execute anything written here.
          </p>

          <label className="field">
            <span>Persona</span>
            <textarea
              rows={3}
              value={form.persona}
              disabled={readOnly}
              placeholder="You are the front desk for Webinfoys. Be brief, warm and factual."
              onChange={(e) => set('persona', e.target.value)}
            />
            <span className="muted small">
              Who the assistant is and how it should sound. Long values are trimmed by the server
              before being sent to the model.
            </span>
          </label>

          <label className="field">
            <span>Business rules</span>
            <textarea
              rows={4}
              value={form.businessRules}
              disabled={readOnly}
              placeholder={'Never quote prices.\nAlways offer a callback for billing questions.'}
              onChange={(e) => set('businessRules', e.target.value)}
            />
            <span className="muted small">
              Things the assistant must or must not do. One per line reads best.
            </span>
          </label>

          <label className="field">
            <span>Reference information / FAQ</span>
            <textarea
              rows={6}
              value={form.faq}
              disabled={readOnly}
              placeholder={'Q: What are your hours?\nA: 9am to 6pm, Monday to Friday.'}
              onChange={(e) => set('faq', e.target.value)}
            />
            <span className="muted small">
              Stored as free text, so any layout works — question and answer pairs are easiest for
              the model to use. The assistant is instructed to answer only from what it is given
              here and to offer a human when it does not know.
            </span>
          </label>
        </div>

        {/* ---- A9: escalation keywords ---------------------------------- */}
        <div className="card">
          <h3>Escalation keywords</h3>
          <p className="muted small">
            An inbound message containing any of these hands the conversation to a human instead of
            being answered. Matched as whole words, ignoring case, so <code className="mono">human</code>{' '}
            does not trigger on &ldquo;humane&rdquo;.
          </p>

          <div className="chip-row" style={{ marginBottom: 10 }}>
            {form.escalationKeywords.length === 0 ? (
              <span className="muted small">No keywords — nothing escalates on wording alone.</span>
            ) : (
              form.escalationKeywords.map((k) => (
                <span className="chip" key={k}>
                  {k}
                  {!readOnly && (
                    <button
                      type="button"
                      className="ai-chip-x"
                      aria-label={`Remove keyword ${k}`}
                      onClick={() => removeKeyword(k)}
                    >
                      ×
                    </button>
                  )}
                </span>
              ))
            )}
          </div>

          {!readOnly && (
            <div className="ai-keyword-add">
              <label className="field" style={{ marginBottom: 0, flex: 1 }}>
                <span className="sr-only-label">Add an escalation keyword</span>
                <input
                  value={keyword}
                  placeholder="lawyer"
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addKeyword();
                    }
                  }}
                />
              </label>
              <button type="button" className="btn btn-sm" onClick={addKeyword} disabled={!keyword.trim()}>
                Add
              </button>
            </div>
          )}
        </div>

        {/* ---- A10: limits ---------------------------------------------- */}
        <div className="card">
          <h3>Limits</h3>
          <div className="ai-grid">
            {NUMERIC_FIELDS.map((f) => (
              <label className="field" key={f.key}>
                <span>{f.label}</span>
                <input
                  type="number"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={form[f.key]}
                  disabled={readOnly}
                  aria-invalid={fieldErrors[f.key] ? 'true' : undefined}
                  onChange={(e) => set(f.key, e.target.value)}
                />
                {fieldErrors[f.key] && (
                  <span className="small ai-over-limit">{fieldErrors[f.key]}</span>
                )}
                <span className="muted small">{f.hint}</span>
              </label>
            ))}
          </div>
        </div>

        {/* ---- A11: one save ------------------------------------------- */}
        {!readOnly && (
          <div className="card ai-save-bar">
            <div className="muted small">
              {dirty ? 'You have unsaved changes.' : 'Everything here matches the server.'}
            </div>
            <div className="row-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={saving || !dirty}
                onClick={() => {
                  setForm(formFromSettings(settings));
                  setKeyInput('');
                  setFieldErrors({});
                  setError('');
                  setNotice('');
                }}
              >
                Discard changes
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        )}
        {readOnly && (
          <div className="card">
            <p className="muted small" style={{ margin: 0 }}>
              You can see this configuration but not change it. AI settings are administrator-only,
              and the server enforces that regardless of what this page shows.
            </p>
          </div>
        )}
      </form>

      {confirmToggle && (
        <ConfirmDialog
          title={settings.enabled ? 'Turn the AI assistant off?' : 'Turn the AI assistant on?'}
          confirmLabel={settings.enabled ? 'Turn off' : 'Turn on'}
          danger={settings.enabled}
          busy={togglingAi}
          onClose={() => setConfirmToggle(false)}
          onConfirm={toggleAi}
          message={
            settings.enabled ? (
              <>
                <p>
                  The assistant will stop processing inbound messages. <strong>No drafts are
                  deleted</strong> — anything already waiting for review stays in the queue and can
                  still be approved or discarded.
                </p>
              </>
            ) : (
              <>
                <p>
                  The assistant will start reading inbound messages and preparing replies.
                  {form.defaultMode === 'auto' ? (
                    <>
                      {' '}
                      The platform default is <strong>auto mode</strong>, so it may send replies
                      itself when every backend safety check passes.
                    </>
                  ) : (
                    <>
                      {' '}
                      The platform default is <strong>draft mode</strong>, so it will not send
                      anything — each reply waits for a person.
                    </>
                  )}
                </p>
                <p className="muted small">
                  This does not send any message now, and it does not change your Twilio or SMS
                  settings.
                </p>
              </>
            )
          }
        />
      )}

      {confirmClearKey && (
        <ConfirmDialog
          title="Remove the stored API key?"
          confirmLabel="Remove key"
          busy={saving}
          onClose={() => setConfirmClearKey(false)}
          onConfirm={clearKey}
          message={
            <p>
              The encrypted key is deleted from the database. The assistant cannot generate replies
              without one, so it will record errors until a new key is saved.
            </p>
          }
        />
      )}
    </>
  );
}
