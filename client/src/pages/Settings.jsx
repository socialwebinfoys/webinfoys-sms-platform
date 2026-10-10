// Settings screen: Twilio configuration status, the SMS-enabled toggle, and a
// small "send test SMS" form. Credentials are managed via environment variables
// on the server and are never shown or edited here.
import { useEffect, useState } from 'react';
import api from '../services/api';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import SmsCounter from '../components/SmsCounter';
import {
  INBOX_REFRESH_OPTIONS,
  normalizeRefreshSeconds,
  refreshOptionLabel,
} from '../utils/inboxRefresh';

// US zones first — this platform sends to US numbers by default — then a few
// common others. The backend validates whatever is submitted.
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Puerto_Rico',
  'America/Toronto',
  'America/Vancouver',
  'Europe/London',
  'Asia/Kolkata',
  'UTC',
];

const DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

// "14" -> "2 PM", "0" -> "12 AM", "24" -> "12 AM (midnight)".
function hourLabel(h) {
  if (h === 24) return '12 AM (midnight)';
  const suffix = h < 12 ? 'AM' : 'PM';
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base} ${suffix}`;
}

// Current hour / weekday in an IANA zone — mirrors the server's window logic
// so the "Now in window" line reflects what the worker will actually do.
function zoneNow(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(new Date());
    const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
    const names = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { hour, day: names[parts.find((p) => p.type === 'weekday').value] };
  } catch {
    return null;
  }
}

function localTimeIn(timezone) {
  try {
    return new Date().toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

// Phase 7: the six Twilio Lookup line types, with a plain-English note on what
// choosing each one actually means for deliverability and compliance.
const LINE_TYPE_LABELS = [
  { key: 'mobile', label: 'Mobile', hint: 'Ordinary mobile numbers. These are the only ones guaranteed to receive SMS.' },
  { key: 'landline', label: 'Landline', hint: 'Fixed-line numbers. SMS to these is usually undeliverable and still billed.' },
  { key: 'fixedVoip', label: 'Fixed VoIP', hint: 'VoIP tied to a physical address (e.g. a desk phone service). Delivery varies by provider.' },
  { key: 'nonFixedVoip', label: 'Non-fixed VoIP', hint: 'App-based numbers (e.g. Google Voice). Often deliverable, but more associated with spam complaints.' },
  { key: 'tollFree', label: 'Toll-free', hint: 'Toll-free numbers. Messaging these requires toll-free verification on the Twilio side.' },
  { key: 'unknown', label: 'Unknown', hint: 'Lookup could not classify the number. Allowing this weakens the filter — the type is a guess.' },
];

export default function Settings() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [twilio, setTwilio] = useState(null);
  const [settings, setSettings] = useState({
    smsEnabled: true,
    mobileOnly: false,
    defaultFrom: '',
    allowedLineTypes: [],
    lookupMaxAgeDays: 30,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingMsg, setSavingMsg] = useState('');

  // Sending window / automation settings (Phase 2).
  const [automation, setAutomation] = useState(null);
  const [savingWindow, setSavingWindow] = useState(false);
  const [windowMsg, setWindowMsg] = useState('');
  const [windowError, setWindowError] = useState('');
  // Re-render once a minute so "Now in window" stays accurate.
  const [, setTick] = useState(0);

  // Inbox auto-refresh. Loaded on its own so a failure here cannot hide the
  // rest of the page.
  const [inboxRefresh, setInboxRefresh] = useState(null);
  const [savingInbox, setSavingInbox] = useState(false);
  const [inboxMsg, setInboxMsg] = useState('');
  const [inboxError, setInboxError] = useState('');

  // send-test form
  const [to, setTo] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState('');
  const [sendError, setSendError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [{ data }, { data: auto }] = await Promise.all([
        api.get('/settings/twilio'),
        api.get('/settings/automation'),
      ]);
      setTwilio(data.twilio);
      setSettings(data.settings);
      setAutomation({
        sendingWindow: auto.sendingWindow,
        sendDays: auto.sendDays || [0, 1, 2, 3, 4, 5, 6],
        maxSendsPerRun: auto.maxSendsPerRun ?? '',
        envMaxSendsPerRun: auto.envMaxSendsPerRun,
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    api
      .get('/settings/inbox')
      .then(({ data }) => setInboxRefresh(normalizeRefreshSeconds(data.settings?.inboxRefreshSeconds)))
      .catch(() => setInboxError('Failed to load the Inbox refresh setting'));
  }, []);

  const saveInboxRefresh = async (seconds) => {
    setInboxMsg('');
    setInboxError('');
    setSavingInbox(true);
    try {
      const { data } = await api.put('/settings/inbox', { inboxRefreshSeconds: seconds });
      setInboxRefresh(normalizeRefreshSeconds(data.settings?.inboxRefreshSeconds));
      setInboxMsg('Inbox refresh saved. Open Inbox pages pick it up when reloaded.');
    } catch (err) {
      setInboxError(err.response?.data?.message || 'Failed to save the Inbox refresh setting');
    } finally {
      setSavingInbox(false);
    }
  };

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60000);
    return () => clearInterval(id);
  }, []);

  // Save the sending window. Sends only what changed-shaped payload the API
  // expects; the server validates hours, timezone, days and the cap.
  const saveAutomation = async (patch) => {
    setWindowMsg('');
    setWindowError('');
    setSavingWindow(true);
    try {
      const { data } = await api.put('/settings/automation', patch);
      setAutomation({
        sendingWindow: data.sendingWindow,
        sendDays: data.sendDays || [],
        maxSendsPerRun: data.maxSendsPerRun ?? '',
        envMaxSendsPerRun: data.envMaxSendsPerRun,
      });
      setWindowMsg('Sending window saved.');
    } catch (err) {
      setWindowError(err.response?.data?.message || 'Failed to save the sending window');
    } finally {
      setSavingWindow(false);
    }
  };

  // Does the window currently allow sending? Same rule as the worker:
  // inside the hour range AND on an allowed day, in the window's timezone.
  const windowStatus = () => {
    if (!automation) return null;
    const w = automation.sendingWindow;
    if (!w.enabled) return { open: true, reason: 'window disabled — automation may send at any time' };
    const z = zoneNow(w.timezone);
    if (!z) return { open: true, reason: 'timezone could not be read' };
    const inHours =
      w.startHour <= w.endHour
        ? z.hour >= w.startHour && z.hour < w.endHour
        : z.hour >= w.startHour || z.hour < w.endHour;
    const days = automation.sendDays || [];
    const onDay = days.length === 0 || days.length >= 7 || days.includes(z.day);
    return {
      open: inHours && onDay,
      reason: !inHours ? 'outside the configured hours' : !onDay ? 'not an allowed send day' : '',
    };
  };

  const saveSettings = async (patch) => {
    setSavingMsg('');
    setError('');
    try {
      const { data } = await api.put('/settings/twilio', patch);
      setSettings(data.settings);
      setTwilio(data.twilio);
      setSavingMsg('Settings saved.');
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to save settings');
    }
  };

  const sendTest = async (e) => {
    e.preventDefault();
    setSending(true);
    setSendResult('');
    setSendError('');
    try {
      const { data } = await api.post('/sms/send', { to, body });
      setSendResult(
        `Sent (${data.result.simulated ? 'simulated' : data.result.status}) to ${data.result.to} — SID ${data.result.sid}`
      );
      setBody('');
    } catch (err) {
      setSendError(err.response?.data?.message || 'Failed to send');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <div className="page"><Spinner label="Loading settings…" /></div>;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="page-sub">Twilio status, sending controls and a test message.</div>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {/* Twilio status */}
      <div className="card">
        <h3>Twilio</h3>
        {twilio && (
          <table className="kv">
            <tbody>
              <tr>
                <td className="muted">Configured</td>
                <td>
                  <span className={twilio.configured ? 'chip chip-on' : 'chip'}>
                    {twilio.configured ? 'yes' : 'no'}
                  </span>
                  {twilio.simulate && <span className="chip" style={{ marginLeft: 8 }}>simulate mode</span>}
                </td>
              </tr>
              <tr>
                <td className="muted">Account SID</td>
                <td className="mono">{twilio.accountSid || <span className="muted">— (set via env)</span>}</td>
              </tr>
              <tr>
                <td className="muted">From number</td>
                <td className="mono">{twilio.from || <span className="muted">— (set via env)</span>}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="muted small">
          Credentials are configured on the server via environment variables and are never shown or
          edited here.
        </p>
      </div>

      {/* Operational settings */}
      <div className="card">
        <h3>SMS sending</h3>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={settings.smsEnabled}
            disabled={!isAdmin}
            onChange={(e) => saveSettings({ smsEnabled: e.target.checked })}
          />
          <span>SMS sending enabled {!isAdmin && <em className="muted">(admin only)</em>}</span>
        </label>
        {/* Phase 7: allowed line types replace the old mobile-only switch. */}
        <div className="field" style={{ marginTop: 14 }}>
          <span>Allowed line types {!isAdmin && <em className="muted">(admin only)</em>}</span>
          <div className="muted small" style={{ marginBottom: 8 }}>
            Outbound campaign and manual sends go only to numbers Twilio Lookup classifies as one
            of these. A number whose type cannot be established is blocked rather than guessed at.
            {settings.allowedLineTypesConfigured === false && (
              <> Currently derived from the old mobile-only setting — saving here replaces it.</>
            )}
          </div>
          {LINE_TYPE_LABELS.map(({ key, label, hint }) => {
            const checked = (settings.allowedLineTypes || []).includes(key);
            return (
              <label className="checkbox-field" key={key}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!isAdmin}
                  onChange={(e) => {
                    const current = new Set(settings.allowedLineTypes || []);
                    if (e.target.checked) current.add(key); else current.delete(key);
                    const next = [...current];
                    // The server rejects an empty list (it would block every
                    // message); say so here rather than letting the save fail.
                    if (next.length === 0) {
                      setSavingMsg('Keep at least one line type — an empty list would block every message.');
                      return;
                    }
                    saveSettings({ allowedLineTypes: next });
                  }}
                />
                <span>
                  {label}
                  <div className="muted small">{hint}</div>
                </span>
              </label>
            );
          })}
        </div>

        <label className="field" style={{ maxWidth: 260 }}>
          <span>Re-check a number&apos;s type after</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number" min="1" max="3650"
              value={settings.lookupMaxAgeDays ?? 30}
              disabled={!isAdmin}
              onChange={(e) => setSettings((s) => ({ ...s, lookupMaxAgeDays: e.target.value }))}
              onBlur={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 3650) saveSettings({ lookupMaxAgeDays: n });
              }}
            />
            <span className="muted small">days</span>
          </div>
          <span className="muted small">
            Numbers can be ported between carriers, so an older classification is looked up again
            before sending.
          </span>
        </label>

        {savingMsg && <div className="alert alert-info">{savingMsg}</div>}
      </div>

      {/* Sending window (Phase 2) */}
      {automation && (
        <div className="card">
          <h3>Sending window</h3>
          <p className="muted small">
            When the automation worker is allowed to send campaign and follow-up messages. US rules
            allow 8 AM – 9 PM in the recipient&apos;s local time. A contact with their own timezone
            is evaluated in that zone; everyone else uses the one selected here.
          </p>

          {(() => {
            const st = windowStatus();
            const w = automation.sendingWindow;
            return (
              <div className={st.open ? 'alert alert-info' : 'alert alert-error'}>
                <div>
                  <strong>Now in window: {st.open ? 'Yes' : 'No'}</strong>
                  <div className="muted small">
                    {localTimeIn(w.timezone)} in {w.timezone}
                    {st.reason ? ` · ${st.reason}` : ''}
                  </div>
                </div>
              </div>
            );
          })()}

          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={automation.sendingWindow.enabled}
              disabled={!isAdmin || savingWindow}
              onChange={(e) => saveAutomation({ sendingWindow: { enabled: e.target.checked } })}
            />
            <span>
              Restrict automation to a sending window{' '}
              {!isAdmin && <em className="muted">(admin only)</em>}
              <div className="muted small">
                When off, the cron worker may send at any hour of any day.
              </div>
            </span>
          </label>

          <div className="filters">
            <label className="field">
              <span>Start hour</span>
              <select
                className="input"
                value={automation.sendingWindow.startHour}
                disabled={!isAdmin || savingWindow}
                onChange={(e) =>
                  saveAutomation({ sendingWindow: { startHour: Number(e.target.value) } })
                }
              >
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>{hourLabel(h)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>End hour</span>
              <select
                className="input"
                value={automation.sendingWindow.endHour}
                disabled={!isAdmin || savingWindow}
                onChange={(e) =>
                  saveAutomation({ sendingWindow: { endHour: Number(e.target.value) } })
                }
              >
                {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                  <option key={h} value={h}>{hourLabel(h)}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Timezone</span>
              <select
                className="input"
                value={automation.sendingWindow.timezone}
                disabled={!isAdmin || savingWindow}
                onChange={(e) =>
                  saveAutomation({ sendingWindow: { timezone: e.target.value } })
                }
              >
                {(TIMEZONES.includes(automation.sendingWindow.timezone)
                  ? TIMEZONES
                  : [automation.sendingWindow.timezone, ...TIMEZONES]
                ).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="field">
            <span>Sending days</span>
            <div className="row-actions" style={{ flexWrap: 'wrap' }}>
              {DAYS.map((d) => {
                const checked = (automation.sendDays || []).includes(d.value);
                return (
                  <label className="checkbox-field" key={d.value} style={{ marginRight: 12 }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!isAdmin || savingWindow}
                      onChange={(e) => {
                        const next = new Set(automation.sendDays || []);
                        if (e.target.checked) next.add(d.value);
                        else next.delete(d.value);
                        if (next.size === 0) {
                          setWindowError('Select at least one sending day');
                          return;
                        }
                        saveAutomation({ sendDays: [...next] });
                      }}
                    />
                    <span>{d.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <label className="field">
            <span>Max sends per minute</span>
            <input
              type="number"
              min="1"
              max="1000"
              className="input input-narrow"
              value={automation.maxSendsPerRun}
              disabled={!isAdmin || savingWindow}
              placeholder={String(automation.envMaxSendsPerRun ?? '')}
              onChange={(e) =>
                setAutomation((a) => ({ ...a, maxSendsPerRun: e.target.value }))
              }
              onBlur={(e) => {
                const raw = e.target.value.trim();
                saveAutomation({ maxSendsPerRun: raw === '' ? null : Number(raw) });
              }}
            />
            <div className="muted small">
              The worker runs once a minute. Leave blank to use the server default
              ({automation.envMaxSendsPerRun}).
            </div>
          </label>

          {windowError && <div className="alert alert-error">{windowError}</div>}
          {windowMsg && <div className="alert alert-info">{windowMsg}</div>}
        </div>
      )}

      {/* Inbox auto-refresh */}
      <div className="card">
        <h3>Inbox</h3>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Auto-refresh {!isAdmin && <em className="muted">(admin only)</em>}</span>
          <select
            className="input"
            value={inboxRefresh ?? ''}
            disabled={!isAdmin || savingInbox || inboxRefresh === null}
            onChange={(e) => saveInboxRefresh(Number(e.target.value))}
          >
            {inboxRefresh === null && <option value="">Loading…</option>}
            {INBOX_REFRESH_OPTIONS.map((s) => (
              <option key={s} value={s}>{refreshOptionLabel(s)}</option>
            ))}
          </select>
          <span className="muted small">
            How often the Inbox checks for new messages. With Off, use the Inbox&apos;s Refresh
            button.
          </span>
        </label>
        {inboxError && <div className="alert alert-error">{inboxError}</div>}
        {inboxMsg && <div className="alert alert-info">{inboxMsg}</div>}
      </div>

      {/* Send test */}
      <div className="card">
        <h3>Send a test SMS</h3>
        <form onSubmit={sendTest}>
          <label className="field">
            <span>To (phone number)</span>
            <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+14155552671" required />
          </label>
          <label className="field">
            <span>Message</span>
            <textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} required />
            <SmsCounter text={body} />
          </label>
          {sendError && <div className="alert alert-error">{sendError}</div>}
          {sendResult && <div className="alert alert-info">{sendResult}</div>}
          <button className="btn btn-primary" type="submit" disabled={sending}>
            {sending ? 'Sending…' : 'Send test SMS'}
          </button>
        </form>
      </div>
    </div>
  );
}
