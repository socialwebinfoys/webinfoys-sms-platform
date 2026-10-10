// Phase 10 — AI analytics and Test Reply, frontend.
//
// Three layers, same as Phase 9: the pure presentation logic, the API contracts
// through the real axios instance, and the real components rendered.
//
// The claims that matter most here:
//   * a missing measurement renders as an em dash, never as 0;
//   * no cost figure is ever displayed;
//   * no takeover rate is displayed, because the server does not supply one;
//   * Test Reply says, visibly and repeatedly, that nothing was sent;
//   * everything untrusted is escaped.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import api from '../src/services/api.js';
import aiApi from '../src/services/aiApi.js';
import AiAnalytics from '../src/components/AiAnalytics.jsx';
import AiTestReply from '../src/components/AiTestReply.jsx';
import AiAssistant from '../src/pages/AiAssistant.jsx';
import { AuthProvider } from '../src/context/AuthContext.jsx';
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
} from '../src/utils/aiPresentation.js';

const h = React.createElement;
const render = (el) => renderToStaticMarkup(el);
const asUser = (role, el) => {
  localStorage.setItem('user', JSON.stringify({ _id: 'u1', name: 'Test', role }));
  localStorage.setItem('token', 'test-jwt');
  try {
    return render(h(AuthProvider, null, el));
  } finally {
    localStorage.clear();
  }
};

// --- stub transport (same approach as the Phase 9 API tests) ----------------
let calls = [];
let responder = () => ({ status: 200, data: { success: true } });
api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    params: config.params,
    data: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data,
  });
  const { status, data } = responder(config);
  const response = { status, statusText: '', data, headers: {}, config, request: {} };
  const validate = config.validateStatus || ((s) => s >= 200 && s < 300);
  if (!validate(status)) {
    throw new axios.AxiosError(
      `Request failed with status code ${status}`,
      status >= 500 ? axios.AxiosError.ERR_BAD_RESPONSE : axios.AxiosError.ERR_BAD_REQUEST,
      config,
      response.request,
      response
    );
  }
  return response;
};
const lastCall = () => calls[calls.length - 1];

beforeEach(() => {
  calls = [];
  responder = () => ({ status: 200, data: { success: true } });
  localStorage.clear();
});

// A representative analytics payload, shaped exactly like the server's.
const ANALYTICS = {
  success: true,
  range: '7d',
  rangeStart: '2026-09-27T00:00:00.000Z',
  generatedAt: '2026-10-04T12:00:00.000Z',
  jobs: {
    total: 10,
    byStatus: { pending: 0, processing: 0, drafted: 2, sent: 4, skipped: 2, escalated: 1, failed: 1, rejected: 0 },
    sent: 4,
    sentAuto: 1,
    sentApproved: 3,
    edited: 1,
    awaitingReview: 2,
    sentRate: 0.4,
    skipRate: 0.2,
    escalationRate: 0.1,
    failureRate: 0.1,
    rejectionRate: 0,
  },
  confidence: {
    measured: 6,
    missing: 4,
    average: 0.8,
    min: 0.45,
    max: 0.97,
    threshold: 0.7,
    atOrAboveThreshold: 5,
    belowThreshold: 1,
    distribution: [
      { from: 0, to: 0.2, n: 0 },
      { from: 0.2, to: 0.4, n: 0 },
      { from: 0.4, to: 0.6, n: 1 },
      { from: 0.6, to: 0.8, n: 1 },
      { from: 0.8, to: 1, n: 4 },
    ],
  },
  providers: [
    { provider: 'openai', model: 'gpt-4o-mini', jobs: 7, sent: 3, failed: 1, totalTokens: 1400 },
    { provider: 'groq', model: 'llama-3.3-70b-versatile', jobs: 3, sent: 1, failed: 0, totalTokens: 600 },
  ],
  usage: { promptTokens: 1500, completionTokens: 500, totalTokens: 2000, jobsWithUsage: 8, jobsWithoutUsage: 2 },
  reasons: [
    { reason: 'opted_out', status: 'skipped', n: 2 },
    { reason: 'escalation_keyword', status: 'escalated', n: 1 },
  ],
  handoff: {
    takeoversEnabled: 2,
    takeoversReleased: 1,
    escalatedJobs: 1,
    conversationsWithAiActivity: 6,
    conversationsEscalatedNow: 3,
    conversationsUnderTakeoverNow: 1,
  },
  activity: {
    runs: 12,
    providerErrors: 5,
    settingsChanges: 2,
    draftsApproved: 3,
    draftsRejected: 1,
    draftsBlocked: 0,
    sendFailures: 0,
    modeChanges: 0,
    byEventType: [
      { eventType: 'ai.run', severity: 'info', n: 12 },
      { eventType: 'ai.provider.error', severity: 'error', n: 5 },
    ],
  },
  notes: { sources: 'x', takeoverRate: 'Not calculated', cost: 'Not calculated', pointInTime: 'y' },
};

const EMPTY_ANALYTICS = {
  ...ANALYTICS,
  jobs: { ...ANALYTICS.jobs, total: 0, byStatus: { pending: 0, processing: 0, drafted: 0, sent: 0, skipped: 0, escalated: 0, failed: 0, rejected: 0 }, sent: 0, sentAuto: 0, sentApproved: 0, edited: 0, awaitingReview: 0, sentRate: 0, skipRate: 0, escalationRate: 0, failureRate: 0 },
  confidence: { measured: 0, missing: 0, average: null, min: null, max: null, threshold: 0.7, atOrAboveThreshold: 0, belowThreshold: 0, distribution: ANALYTICS.confidence.distribution.map((b) => ({ ...b, n: 0 })) },
  providers: [],
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, jobsWithUsage: 0, jobsWithoutUsage: 0 },
  reasons: [],
  activity: { ...ANALYTICS.activity, runs: 0, providerErrors: 0, byEventType: [] },
};

const SETTINGS = {
  enabled: true,
  defaultMode: 'draft',
  provider: 'openai',
  model: 'gpt-4o-mini',
  availableProviders: ['openai', 'groq', 'gemini'],
  confidenceThreshold: 0.7,
  maxReplyCharacters: 320,
  escalationKeywords: [],
  apiKey: { configured: true, masked: '••••••••wxyz' },
  encryptionConfigured: true,
};

// ===========================================================================
describe('analytics formatting', () => {
  test('the range list matches the existing analytics API', () => {
    assert.deepEqual(ANALYTICS_RANGES.map((r) => r.key), ['today', '7d', '30d', 'all']);
    assert.equal(rangeLabel('7d'), 'Last 7 days');
    assert.equal(rangeLabel('nonsense'), 'All time');
  });

  test('a percentage with no denominator is an em dash, never 0%', () => {
    assert.equal(formatPercent(0.5, 0), '—');
    assert.equal(formatPercent(0.5, null), '—');
    assert.equal(formatPercent(0.5, undefined), '—');
    assert.equal(formatPercent(0.4, 10), '40.0%');
  });

  test('a real zero still shows as 0.0%', () => {
    assert.equal(formatPercent(0, 10), '0.0%');
  });

  test('a non-numeric rate never renders NaN', () => {
    assert.equal(formatPercent(undefined, 10), '—');
    assert.equal(formatPercent(NaN, 10), '—');
    assert.equal(formatPercent(Infinity, 10), '—');
  });

  test('counts are formatted, and 0 is shown as 0', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(1500), (1500).toLocaleString());
    assert.equal(formatCount(undefined), '—');
    assert.equal(formatCount('abc'), '—');
  });

  test('an unmeasured average confidence is an em dash, NOT 0%', () => {
    for (const c of [null, undefined, { measured: 0, average: null }, { measured: 0, average: 0 }]) {
      const out = formatAverageConfidence(c);
      assert.equal(out.value, '—', 'missing confidence must never render as a percentage');
      assert.equal(out.hasData, false);
    }
  });

  test('a measured average confidence renders as a percentage', () => {
    const out = formatAverageConfidence({ measured: 6, average: 0.8 });
    assert.equal(out.value, '80%');
    assert.equal(out.measured, 6);
    assert.equal(out.hasData, true);
  });

  test('a genuinely low average is shown, not suppressed', () => {
    assert.equal(formatAverageConfidence({ measured: 3, average: 0.02 }).value, '2%');
  });
});

// ===========================================================================
describe('event labels', () => {
  const BACKEND_EVENTS = [
    'ai.run', 'ai.reply.sent', 'ai.reply.drafted', 'ai.reply.skipped', 'ai.reply.escalated',
    'ai.provider.error', 'ai.settings.updated', 'ai.takeover.enabled', 'ai.takeover.released',
    'ai.draft.approved', 'ai.draft.rejected', 'ai.draft.blocked', 'ai.draft.send_failed',
    'ai.mode.changed',
  ];

  test('every event the backend emits has a readable label', () => {
    for (const type of BACKEND_EVENTS) {
      const label = eventTypeLabel(type);
      assert.ok(label.length > 3, `${type} has no label`);
      assert.ok(!label.includes('.'), `${type} leaked a raw token: ${label}`);
      assert.ok(!label.includes('_'), `${type} leaked an underscore: ${label}`);
    }
  });

  test('an unknown AI event degrades to a readable form', () => {
    assert.equal(eventTypeLabel('ai.brand.new_thing'), 'Brand new thing');
  });

  test('an empty event type does not render blank', () => {
    assert.equal(eventTypeLabel(''), 'Unknown event');
    assert.equal(eventTypeLabel(undefined), 'Unknown event');
  });

  test('severity maps to a chip class, defaulting to neutral', () => {
    assert.equal(severityChipClass('error'), 'chip chip-invalid');
    assert.equal(severityChipClass('warning'), 'chip chip-warn');
    assert.equal(severityChipClass('info'), 'chip');
    assert.equal(severityChipClass('nonsense'), 'chip');
  });
});

// ===========================================================================
describe('outcome breakdown', () => {
  test('only non-zero outcomes are listed, with shares that sum to 1', () => {
    const rows = outcomeBreakdown(ANALYTICS.jobs);
    assert.deepEqual(rows.map((r) => r.status), ['sent', 'drafted', 'skipped', 'escalated', 'failed']);
    const total = rows.reduce((a, r) => a + r.value, 0);
    assert.equal(total, ANALYTICS.jobs.total, 'the breakdown must account for every attempt once');
    const shares = rows.reduce((a, r) => a + r.share, 0);
    assert.ok(Math.abs(shares - 1) < 1e-9);
  });

  test('an unknown status from a newer backend is still included', () => {
    const rows = outcomeBreakdown({ total: 3, byStatus: { sent: 1, teleported: 2 } });
    assert.ok(rows.some((r) => r.status === 'teleported' && r.value === 2));
  });

  test('empty data produces an empty list rather than a row of zeroes', () => {
    assert.deepEqual(outcomeBreakdown(EMPTY_ANALYTICS.jobs), []);
    assert.deepEqual(outcomeBreakdown(null), []);
  });

  test('shares are 0 rather than NaN when the total is 0', () => {
    const rows = outcomeBreakdown({ total: 0, byStatus: { sent: 0 } });
    assert.deepEqual(rows, []);
  });
});

describe('activity detection and bands', () => {
  test('activity is detected from jobs or events', () => {
    assert.equal(hasAiActivity(ANALYTICS), true);
    assert.equal(hasAiActivity(EMPTY_ANALYTICS), false);
    assert.equal(hasAiActivity(null), false);
    assert.equal(hasAiActivity({ jobs: { total: 0 }, activity: { byEventType: [{ eventType: 'ai.run', n: 1 }] } }), true);
  });

  test('confidence bands are labelled from the server boundaries', () => {
    const bands = confidenceBands(ANALYTICS.confidence);
    assert.equal(bands.length, 5);
    assert.equal(bands[0].label, '0–20%');
    assert.equal(bands[4].label, '80–100%');
    assert.equal(bands[4].value, 4);
  });

  test('missing distribution data yields no bands rather than throwing', () => {
    assert.deepEqual(confidenceBands(null), []);
    assert.deepEqual(confidenceBands({}), []);
  });
});

// ===========================================================================
describe('analytics API contract', () => {
  test('GET /analytics/ai with the selected range', async () => {
    responder = () => ({ status: 200, data: ANALYTICS });
    const data = await aiApi.getAnalytics('30d');
    assert.equal(lastCall().method, 'get');
    assert.equal(lastCall().url, '/analytics/ai');
    assert.deepEqual(lastCall().params, { range: '30d' });
    assert.equal(data.jobs.total, 10);
  });

  test('the activity table reuses the existing paginated log endpoint', async () => {
    responder = () => ({ status: 200, data: { success: true, data: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } } });
    await aiApi.listAiEvents({ page: 2, limit: 20, severity: 'error' });
    assert.equal(lastCall().url, '/logs');
    assert.equal(lastCall().params.eventPrefix, 'ai.', 'the table must ask for AI events only');
    assert.equal(lastCall().params.page, 2);
    assert.equal(lastCall().params.severity, 'error');
  });

  test('the events call is always bounded by a limit', async () => {
    responder = () => ({ status: 200, data: { success: true, data: [], pagination: null } });
    await aiApi.listAiEvents({ page: 1, limit: 20 });
    assert.ok(lastCall().params.limit, 'no limit was sent — the table could load everything');
  });

  test('an analytics failure rejects so the UI shows an error', async () => {
    responder = () => ({ status: 500, data: { success: false, message: 'internal detail' } });
    await assert.rejects(() => aiApi.getAnalytics('7d'));
  });
});

// ===========================================================================
describe('Test Reply API contract', () => {
  test('POST /ai/test sends only the message', async () => {
    responder = () => ({ status: 200, data: { success: true, sent: false, reply: 'Yes, until 6pm.', confidence: 0.9 } });
    await aiApi.testReply('are you open?');
    assert.equal(lastCall().method, 'post');
    assert.equal(lastCall().url, '/ai/test');
    assert.deepEqual(Object.keys(lastCall().data), ['message']);
    assert.equal(lastCall().data.message, 'are you open?');
  });

  test('the server states that nothing was sent', async () => {
    responder = () => ({ status: 200, data: { success: true, sent: false, reply: 'ok' } });
    const data = await aiApi.testReply('hi');
    assert.equal(data.sent, false);
  });

  test('NO contact, conversation or recipient is ever sent', async () => {
    responder = () => ({ status: 200, data: { success: true, sent: false, reply: 'ok' } });
    await aiApi.testReply('hi');
    const body = lastCall().data;
    for (const forbidden of ['to', 'phone', 'contact', 'conversation', 'from']) {
      assert.ok(!(forbidden in body), `${forbidden} was sent to the test endpoint`);
    }
  });

  test('a 429 rate limit rejects and is explained, not swallowed', async () => {
    responder = () => ({ status: 429, data: { success: false, message: 'Too many AI test requests. Please wait a few minutes and try again.' } });
    await assert.rejects(() => aiApi.testReply('hi'), (err) => {
      assert.equal(err.response.status, 429);
      return true;
    });
  });

  test('402/502 provider failures reject', async () => {
    for (const status of [422, 500, 502, 503]) {
      responder = () => ({ status, data: { success: false, message: 'provider failed' } });
      await assert.rejects(() => aiApi.testReply('hi'), `status ${status} should reject`);
    }
  });

  test('the test call never reaches Twilio or a provider directly', async () => {
    responder = () => ({ status: 200, data: { success: true, sent: false, reply: 'ok' } });
    await aiApi.testReply('hi');
    for (const call of calls) {
      assert.match(call.url, /^\//, 'an absolute URL was used');
      assert.ok(!/twilio|openai|groq|googleapis/i.test(call.url), 'the browser called a third party');
    }
    assert.throws(() => globalThis.fetch('https://api.openai.com'), /BLOCKED BY TEST HARNESS/);
  });
});

// ===========================================================================
describe('AiAnalytics rendering', () => {
  test('shows a loading state first', () => {
    const out = render(h(AiAnalytics, {}));
    assert.match(out, /Loading AI analytics/);
  });

  test('the page offers all four tabs including Analytics and Test Reply', () => {
    // AiAssistant uses useNavigate for the conversation deep link, so it needs a
    // Router, exactly as it has in the app.
    const out = asUser('admin', h(MemoryRouter, null, h(AiAssistant)));
    assert.match(out, />Analytics</);
    assert.match(out, />Test Reply</);
    assert.match(out, />Drafts</);
    assert.match(out, />Configuration</);
  });

  test('all four tabs are real tabs with aria-selected', () => {
    const out = asUser('admin', h(MemoryRouter, null, h(AiAssistant)));
    const tabs = out.match(/role="tab"/g) || [];
    assert.equal(tabs.length, 4, 'expected four tabs');
    assert.match(out, /role="tab"[^>]*aria-selected="true"/);
    assert.match(out, /role="tablist"/);
  });
});

// ===========================================================================
describe('AiTestReply rendering', () => {
  const adminOut = (settings = SETTINGS) =>
    asUser('admin', h(AiTestReply, { settings }));

  test('states up front that nothing is sent', () => {
    const out = adminOut();
    assert.match(out, /Nothing is sent/);
    assert.match(out, /No SMS leaves the system/);
  });

  test('has a labelled, accessible input with a character count', () => {
    const out = adminOut();
    assert.match(out, /Hypothetical customer message/);
    assert.match(out, /<textarea/);
    assert.match(out, /aria-describedby="ai-test-count"/);
    assert.match(out, /0\/1000/);
  });

  test('the submit button is disabled until something is typed', () => {
    const out = adminOut();
    const submit = (out.match(/<button[^>]*type="submit"[^>]*>/) || [''])[0];
    assert.match(submit, /disabled=""/);
  });

  test('a non-admin is told the server restricts this, and the input is disabled', () => {
    const out = asUser('user', h(AiTestReply, { settings: SETTINGS }));
    assert.match(out, /Only an administrator can run a test reply/);
    assert.match(out, /server enforces this/);
    assert.match(out, /<textarea[^>]*disabled=""/);
  });

  test('a missing provider is explained before an attempt is made', () => {
    const out = adminOut({ ...SETTINGS, provider: '' });
    assert.match(out, /No AI provider is configured/);
  });

  test('a missing API key is explained', () => {
    const out = adminOut({ ...SETTINGS, apiKey: { configured: false, masked: '' } });
    assert.match(out, /No API key is stored/);
  });

  test('AI being switched off does not block testing, and testing does not enable it', () => {
    const out = adminOut({ ...SETTINGS, enabled: false });
    assert.match(out, /Testing still works/);
    assert.match(out, /does <strong>not<\/strong> turn it on|not<\/strong> turn it on/);
  });

  test('no API key or masked value is rendered on this screen', () => {
    const out = adminOut();
    assert.ok(!out.includes('••••••••wxyz'), 'the masked key leaked onto the test screen');
    assert.ok(!/sk-/.test(out));
  });

  test('every control is a real button or labelled field', () => {
    const out = adminOut();
    const stray = out.replace(/<label[\s\S]*?<\/label>/g, '');
    assert.ok(!/<textarea/.test(stray), 'the textarea is not inside a label');
    for (const b of out.match(/<button[^>]*>/g) || []) {
      assert.ok(/type="(submit|button)"/.test(b), `a button without an explicit type: ${b}`);
    }
  });
});

// ===========================================================================
// The result panel is rendered by driving the component's own markup through a
// stub that returns a result — but effects do not run in server rendering, so
// the result state is exercised through the presentation helpers plus a direct
// source check that the required statements exist.
describe('Test Reply result safety', () => {
  test('the component source states simulation and never styles a result as a bubble', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/components/AiTestReply.jsx', import.meta.url), 'utf8');
    assert.match(source, /Simulation only/);
    assert.match(source, /No SMS was sent/);
    assert.match(source, /not sent to anyone/i);
    // It must not reuse the message-thread bubble classes.
    assert.ok(!/className="bubble/.test(source), 'a test result is styled as a sent message');
    assert.ok(!/bubble-row/.test(source));
  });

  test('no AI component uses unsafe HTML, eval or browser storage', async () => {
    const { readFile } = await import('node:fs/promises');
    const files = [
      '../src/components/AiAnalytics.jsx',
      '../src/components/AiTestReply.jsx',
      '../src/components/AiDraftCard.jsx',
      '../src/components/AiSettingsForm.jsx',
      '../src/components/AiConversationPanel.jsx',
      '../src/pages/AiAssistant.jsx',
      '../src/utils/aiPresentation.js',
      '../src/services/aiApi.js',
    ];
    for (const file of files) {
      const raw = await readFile(new URL(file, import.meta.url), 'utf8');
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      assert.ok(!source.includes('dangerouslySetInnerHTML'), `${file} uses dangerouslySetInnerHTML`);
      assert.ok(!source.includes('innerHTML'), `${file} touches innerHTML`);
      assert.ok(!/\beval\(/.test(source), `${file} uses eval`);
      assert.ok(!/new Function\(/.test(source), `${file} builds a function from a string`);
      assert.ok(!/localStorage|sessionStorage/.test(source), `${file} uses browser storage`);
    }
  });

  test('no AI screen claims a monetary cost', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/components/AiAnalytics.jsx', import.meta.url), 'utf8');
    // The word appears only in the sentence explaining that none is calculated.
    assert.ok(!/\$\{?\s*\w*cost/i.test(source), 'a cost figure is rendered');
    assert.match(source, /no provider pricing model/i);
  });

  test('no takeover rate is rendered — the server does not supply one', async () => {
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../src/components/AiAnalytics.jsx', import.meta.url), 'utf8');
    assert.ok(!/takeoverRate/.test(source), 'the UI computed a takeover rate');
    assert.match(source, /No takeover <em>rate<\/em> is shown/);
  });
});
