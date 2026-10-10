// Phase 9 — the AI API client.
//
// Drives the REAL axios instance from services/api.js (its base URL, its JWT
// interceptor, its 401 handling) through a stub adapter, so every request the AI
// frontend makes is asserted exactly: method, path, and payload.
//
// This is where "the frontend must call the existing backend" is actually
// checked: the wrong verb or a wrong path would pass a rendering test and fail
// here. The harness also blocks fetch and XMLHttpRequest, so nothing can escape
// to a real API, an AI provider or Twilio.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

import api from '../src/services/api.js';
import aiApi from '../src/services/aiApi.js';
import { describeApiError } from '../src/utils/aiPresentation.js';

// --- stub adapter -----------------------------------------------------------
// Replaces only the transport. The instance's baseURL, its request interceptor
// (the JWT header) and its response interceptor (the 401 session clear) all still
// run, which is what makes this a test of the real client rather than of a mock.
//
// An axios adapter is responsible for honouring validateStatus itself — the
// built-in ones call settle(). So a non-2xx is rejected here with a genuine
// AxiosError carrying `.response`, exactly as a real failure arrives.
let calls = [];
let responder = () => ({ status: 200, data: { success: true } });

api.defaults.adapter = async (config) => {
  calls.push({
    method: String(config.method || '').toLowerCase(),
    url: config.url,
    params: config.params,
    // axios has already serialised a JSON body by this point.
    data: typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data,
    headers: config.headers,
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
  sessionStorage.clear();
});

const SETTINGS = {
  enabled: false,
  defaultMode: 'draft',
  provider: 'openai',
  model: 'gpt-4o-mini',
  availableProviders: ['openai', 'groq', 'gemini'],
  defaultModelForProvider: 'gpt-4o-mini',
  persona: 'Be brief.',
  businessRules: '',
  faq: '',
  escalationKeywords: ['human'],
  confidenceThreshold: 0.7,
  maxRepliesPerConversation: 3,
  contextMessageLimit: 10,
  maxReplyCharacters: 320,
  apiKey: { configured: true, masked: '••••••••wxyz' },
  encryptionConfigured: true,
};

// ===========================================================================
describe('settings', () => {
  test('load uses GET /ai/settings and returns the settings object', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    const settings = await aiApi.getSettings();
    assert.equal(lastCall().method, 'get');
    assert.equal(lastCall().url, '/ai/settings');
    assert.equal(settings.provider, 'openai');
    assert.deepEqual(settings.availableProviders, ['openai', 'groq', 'gemini']);
  });

  test('the loaded settings expose only a masked key', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    const settings = await aiApi.getSettings();
    assert.equal(settings.apiKey.configured, true);
    assert.equal(settings.apiKey.masked, '••••••••wxyz');
    // There is no field anywhere that could hold a usable key.
    assert.ok(!('apiKeyEncrypted' in settings));
    assert.ok(!JSON.stringify(settings).includes('sk-'));
  });

  test('save uses PUT and sends only the fields given', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.updateSettings({ defaultMode: 'auto', confidenceThreshold: 0.8 });
    assert.equal(lastCall().method, 'put');
    assert.equal(lastCall().url, '/ai/settings');
    assert.deepEqual(lastCall().data, { defaultMode: 'auto', confidenceThreshold: 0.8 });
  });

  test('enabling and disabling AI go through the same settings endpoint', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: { ...SETTINGS, enabled: true } } });
    await aiApi.updateSettings({ enabled: true });
    assert.deepEqual(lastCall().data, { enabled: true });

    await aiApi.updateSettings({ enabled: false });
    assert.deepEqual(lastCall().data, { enabled: false });
  });

  test('provider, model, persona, rules, FAQ and keywords are all sent as given', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    const patch = {
      provider: 'groq',
      model: 'llama-3.3-70b-versatile',
      persona: 'Be warm.',
      businessRules: 'Never quote prices.',
      faq: 'Q: hours? A: 9-6.',
      escalationKeywords: ['lawyer', 'complaint'],
      maxRepliesPerConversation: 5,
      contextMessageLimit: 12,
      maxReplyCharacters: 400,
    };
    await aiApi.updateSettings(patch);
    assert.deepEqual(lastCall().data, patch);
  });

  test('an API key is sent in the body and NEVER written to browser storage', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.updateSettings({ apiKey: 'sk-test-not-a-real-key-000000' });

    assert.equal(lastCall().data.apiKey, 'sk-test-not-a-real-key-000000');
    // The whole point: it goes one way.
    for (const store of [localStorage, sessionStorage]) {
      const dump = JSON.stringify(store.__entries());
      assert.ok(!dump.includes('sk-test'), 'an API key reached browser storage');
      assert.ok(!dump.includes('apiKey'), 'an API key field reached browser storage');
    }
  });

  test("clearing a key sends an empty string, which is the server's 'clear' signal", async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.updateSettings({ apiKey: '' });
    assert.deepEqual(lastCall().data, { apiKey: '' });
  });

  test('a validation failure rejects and carries the server message', async () => {
    responder = () => ({
      status: 400,
      data: { success: false, message: 'confidenceThreshold must be a number between 0 and 1' },
    });
    await assert.rejects(
      () => aiApi.updateSettings({ confidenceThreshold: 9 }),
      (err) => {
        const d = describeApiError(err);
        assert.equal(d.status, 400);
        assert.match(d.message, /between 0 and 1/);
        return true;
      }
    );
  });

  test('a non-admin save is refused with 403 and the message is shown', async () => {
    responder = () => ({ status: 403, data: { success: false, message: 'Admin role required' } });
    await assert.rejects(
      () => aiApi.updateSettings({ enabled: true }),
      (err) => {
        assert.equal(describeApiError(err).status, 403);
        assert.equal(describeApiError(err).message, 'Admin role required');
        return true;
      }
    );
  });

  test('a missing server encryption key surfaces as 503 with its explanation', async () => {
    responder = () => ({
      status: 503,
      data: {
        success: false,
        message:
          'AI_ENCRYPTION_KEY is not configured on the server, so an API key cannot be stored securely.',
      },
    });
    await assert.rejects(
      () => aiApi.updateSettings({ apiKey: 'sk-x' }),
      (err) => {
        assert.match(describeApiError(err).message, /AI_ENCRYPTION_KEY is not configured/);
        return true;
      }
    );
  });
});

// ===========================================================================
describe('the draft queue', () => {
  test('listing uses GET /ai/jobs and unwraps data + pagination', async () => {
    responder = () => ({
      status: 200,
      data: {
        success: true,
        data: [{ _id: 'j1', status: 'drafted' }],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      },
    });
    const { jobs, pagination } = await aiApi.listJobs({ status: 'drafted', page: 1, limit: 25 });
    assert.equal(lastCall().method, 'get');
    assert.equal(lastCall().url, '/ai/jobs');
    assert.deepEqual(lastCall().params, { status: 'drafted', page: 1, limit: 25 });
    assert.equal(jobs.length, 1);
    assert.equal(pagination.total, 1);
  });

  test('an empty queue yields an empty array, never undefined', async () => {
    responder = () => ({ status: 200, data: { success: true, data: [], pagination: { page: 1, limit: 25, total: 0, pages: 0 } } });
    const { jobs } = await aiApi.listJobs();
    assert.deepEqual(jobs, []);
  });

  test('a conversation filter is passed through', async () => {
    responder = () => ({ status: 200, data: { success: true, data: [], pagination: null } });
    await aiApi.listJobs({ conversation: '6a9a77ec9990e8f4bb000002' });
    assert.equal(lastCall().params.conversation, '6a9a77ec9990e8f4bb000002');
  });

  test('a list failure rejects so the UI can show an error state', async () => {
    responder = () => ({ status: 500, data: { success: false, message: 'boom' } });
    await assert.rejects(() => aiApi.listJobs());
  });
});

// ===========================================================================
describe('approval', () => {
  const OK = {
    status: 200,
    data: {
      success: true,
      job: { _id: 'j1', status: 'sent', edited: false },
      message: { _id: 'm1', source: 'ai', body: 'Hello' },
      result: { sid: 'SIMULATED-1', status: 'simulated', simulated: true },
      edited: false,
    },
  };

  test('approving as generated POSTs an EMPTY body', async () => {
    responder = () => OK;
    await aiApi.approveJob('j1');
    assert.equal(lastCall().method, 'post');
    assert.equal(lastCall().url, '/ai/jobs/j1/approve');
    // {} means "send the stored draft". A missing body key is essential — any
    // value here would be treated as an edit.
    assert.deepEqual(lastCall().data, {});
  });

  test('edit + approve POSTs the edited body', async () => {
    responder = () => ({ ...OK, data: { ...OK.data, edited: true } });
    const result = await aiApi.approveJob('j1', 'We close at 5pm today.');
    assert.deepEqual(lastCall().data, { body: 'We close at 5pm today.' });
    assert.equal(result.edited, true);
  });

  test('the simulated send is reported as such, not as a delivery', async () => {
    responder = () => OK;
    const result = await aiApi.approveJob('j1');
    assert.equal(result.result.simulated, true);
    assert.equal(result.result.status, 'simulated');
  });

  test('approval never sends a recipient, contact, provider or approver', async () => {
    responder = () => OK;
    await aiApi.approveJob('j1', 'text');
    // Only the body. Everything else is the server's to decide.
    assert.deepEqual(Object.keys(lastCall().data), ['body']);
  });

  test('a 409 race is rejected and describes the real job status', async () => {
    responder = () => ({
      status: 409,
      data: {
        success: false,
        message: 'This draft is no longer awaiting approval (status: sent)',
        status: 'sent',
      },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        const d = describeApiError(err);
        assert.equal(d.status, 409);
        assert.equal(d.jobStatus, 'sent');
        return true;
      }
    );
  });

  test('a 403 opt-out is rejected and marks the draft as gone', async () => {
    responder = () => ({
      status: 403,
      data: {
        success: false,
        message: 'This contact has opted out of SMS',
        reason: 'opted_out',
        approvable: false,
      },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        const d = describeApiError(err);
        assert.equal(d.reason, 'opted_out');
        assert.equal(d.draftSurvives, false);
        return true;
      }
    );
  });

  test('a 422 line-type block keeps the draft approvable', async () => {
    responder = () => ({
      status: 422,
      data: { success: false, message: 'line type not allowed', reason: 'line_type_blocked', approvable: true },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        assert.equal(describeApiError(err).draftSurvives, true);
        return true;
      }
    );
  });

  test('a 503 outside the sending window keeps the draft approvable', async () => {
    responder = () => ({
      status: 503,
      data: { success: false, message: 'outside the window', reason: 'outside_window', approvable: true },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        const d = describeApiError(err);
        assert.equal(d.draftSurvives, true);
        assert.equal(d.retryable, true);
        return true;
      }
    );
  });

  test('a 400 over-length edit is rejected with the exact server reason', async () => {
    responder = () => ({
      status: 400,
      data: { success: false, message: 'body is 400 characters; the maximum is 320' },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1', 'x'.repeat(400)),
      (err) => {
        assert.match(describeApiError(err).message, /maximum is 320/);
        return true;
      }
    );
  });
});

// ===========================================================================
describe('rejection', () => {
  test('discarding uses DELETE /ai/jobs/:id', async () => {
    responder = () => ({ status: 200, data: { success: true, job: { _id: 'j1', status: 'rejected' }, changed: true } });
    const result = await aiApi.rejectJob('j1');
    assert.equal(lastCall().method, 'delete');
    assert.equal(lastCall().url, '/ai/jobs/j1');
    assert.equal(result.job.status, 'rejected');
    assert.equal(result.changed, true);
  });

  test('a repeated discard reports changed:false rather than failing', async () => {
    responder = () => ({ status: 200, data: { success: true, job: { _id: 'j1', status: 'rejected' }, changed: false } });
    const result = await aiApi.rejectJob('j1');
    assert.equal(result.changed, false);
  });

  test('discarding never sends a body — there is nothing for a client to decide', async () => {
    responder = () => ({ status: 200, data: { success: true, job: {}, changed: true } });
    await aiApi.rejectJob('j1');
    assert.ok(!lastCall().data, 'a DELETE body was sent');
  });

  test('discarding an already-sent draft is refused with 409', async () => {
    responder = () => ({
      status: 409,
      data: { success: false, message: 'This draft cannot be discarded (status: sent)', status: 'sent' },
    });
    await assert.rejects(
      () => aiApi.rejectJob('j1'),
      (err) => {
        assert.equal(describeApiError(err).jobStatus, 'sent');
        return true;
      }
    );
  });
});

// ===========================================================================
describe('takeover', () => {
  test('taking over POSTs to the takeover path', async () => {
    responder = () => ({ status: 200, data: { success: true, takeover: true, escalated: false } });
    const result = await aiApi.takeOver('k1');
    assert.equal(lastCall().method, 'post');
    assert.equal(lastCall().url, '/ai/conversations/k1/takeover');
    assert.equal(result.takeover, true);
  });

  test('handing back DELETEs the same path', async () => {
    responder = () => ({ status: 200, data: { success: true, takeover: false, escalated: false } });
    const result = await aiApi.releaseTakeover('k1');
    assert.equal(lastCall().method, 'delete');
    assert.equal(lastCall().url, '/ai/conversations/k1/takeover');
    assert.equal(result.takeover, false);
  });

  test('handing back reports that escalation was cleared by the server', async () => {
    responder = () => ({ status: 200, data: { success: true, takeover: false, escalated: false } });
    const result = await aiApi.releaseTakeover('k1');
    assert.equal(result.escalated, false);
  });

  test('a takeover failure rejects rather than silently appearing to work', async () => {
    responder = () => ({ status: 404, data: { success: false, message: 'Conversation not found' } });
    await assert.rejects(() => aiApi.takeOver('k1'));
  });
});

// ===========================================================================
describe('per-conversation mode', () => {
  test("setting draft mode PATCHes { mode: 'draft' }", async () => {
    responder = () => ({
      status: 200,
      data: { success: true, conversation: 'k1', state: { mode: 'draft', takeover: false, replyCount: 2, escalated: false } },
    });
    const result = await aiApi.setConversationMode('k1', 'draft');
    assert.equal(lastCall().method, 'patch');
    assert.equal(lastCall().url, '/ai/conversations/k1');
    assert.deepEqual(lastCall().data, { mode: 'draft' });
    assert.equal(result.state.mode, 'draft');
  });

  test("setting auto mode PATCHes { mode: 'auto' }", async () => {
    responder = () => ({
      status: 200,
      data: { success: true, conversation: 'k1', state: { mode: 'auto', takeover: false, replyCount: 2, escalated: false } },
    });
    await aiApi.setConversationMode('k1', 'auto');
    assert.deepEqual(lastCall().data, { mode: 'auto' });
  });

  test('the response is the authoritative state, including what did not change', async () => {
    responder = () => ({
      status: 200,
      data: {
        success: true,
        conversation: 'k1',
        state: { mode: 'auto', takeover: true, replyCount: 3, escalated: true },
      },
    });
    const result = await aiApi.setConversationMode('k1', 'auto');
    assert.equal(result.state.takeover, true, 'takeover is reported unchanged');
    assert.equal(result.state.replyCount, 3, 'the reply count is reported unchanged');
    assert.equal(result.state.escalated, true, 'escalation is reported unchanged');
  });

  test('an invalid mode is refused by the server and surfaced', async () => {
    responder = () => ({ status: 400, data: { success: false, message: "mode must be 'draft' or 'auto'" } });
    await assert.rejects(
      () => aiApi.setConversationMode('k1', 'off'),
      (err) => {
        assert.match(describeApiError(err).message, /must be 'draft' or 'auto'/);
        return true;
      }
    );
  });

  test('a server error on a mode change rejects, so the UI does not claim success', async () => {
    responder = () => ({ status: 500, data: { success: false, message: 'internal' } });
    await assert.rejects(
      () => aiApi.setConversationMode('k1', 'auto'),
      (err) => {
        // And the internal message is not what the operator is shown.
        assert.ok(!describeApiError(err).message.includes('internal'));
        return true;
      }
    );
  });
});

// ===========================================================================
describe('conversation AI state', () => {
  test('GET /ai/conversations/:id returns state and jobs', async () => {
    responder = () => ({
      status: 200,
      data: {
        success: true,
        conversation: 'k1',
        state: { takeover: false, mode: '', replyCount: 1, escalated: false },
        jobs: [{ _id: 'j1', status: 'drafted' }],
      },
    });
    const data = await aiApi.getConversationAi('k1', { limit: 5 });
    assert.equal(lastCall().method, 'get');
    assert.equal(lastCall().url, '/ai/conversations/k1');
    assert.deepEqual(lastCall().params, { limit: 5 });
    assert.equal(data.jobs.length, 1);
  });
});

// ===========================================================================
describe('the shared axios instance is reused, not reimplemented', () => {
  test('a stored JWT is attached by the existing interceptor', async () => {
    localStorage.setItem('token', 'test-jwt-value');
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.getSettings();
    assert.equal(lastCall().headers.Authorization, 'Bearer test-jwt-value');
  });

  test('every AI path is relative, so the configured base URL applies', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS, data: [], job: {} } });
    await aiApi.getSettings();
    await aiApi.listJobs();
    await aiApi.approveJob('j1');
    await aiApi.rejectJob('j1');
    await aiApi.takeOver('k1');
    await aiApi.setConversationMode('k1', 'draft');
    for (const call of calls) {
      assert.match(call.url, /^\/ai\//, `${call.url} is not a relative /ai path`);
      assert.ok(!call.url.startsWith('http'), 'a hardcoded origin was used');
    }
  });

  test('a 401 clears the stored session, as the existing interceptor does', async () => {
    localStorage.setItem('token', 'expired');
    localStorage.setItem('user', '{"name":"x"}');
    responder = () => ({ status: 401, data: { success: false, message: 'Not authorized' } });
    await assert.rejects(() => aiApi.getSettings());
    assert.equal(localStorage.getItem('token'), null);
    assert.equal(localStorage.getItem('user'), null);
  });

  test('no AI call reaches fetch or XMLHttpRequest', async () => {
    // The harness replaces both with throwing functions, so this passing at all
    // proves requests go through the stubbed axios adapter and nowhere else.
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.getSettings();
    assert.throws(() => globalThis.fetch('/anything'), /BLOCKED BY TEST HARNESS/);
  });
});

// ===========================================================================
describe('Fix 2 — the manual-reply pause setting', () => {
  test('it is sent through the existing settings endpoint', async () => {
    responder = () => ({ status: 200, data: { success: true, settings: SETTINGS } });
    await aiApi.updateSettings({ autoTakeoverOnManualReply: false });
    assert.equal(lastCall().method, 'put');
    assert.equal(lastCall().url, '/ai/settings');
    assert.deepEqual(lastCall().data, { autoTakeoverOnManualReply: false });
  });

  test('it is returned by the settings read', async () => {
    responder = () => ({
      status: 200,
      data: { success: true, settings: { ...SETTINGS, autoTakeoverOnManualReply: false } },
    });
    const settings = await aiApi.getSettings();
    assert.equal(settings.autoTakeoverOnManualReply, false);
  });

  test('a 409 from a stale draft approval is surfaced with its reason', async () => {
    responder = () => ({
      status: 409,
      data: {
        success: false,
        message: 'This chat was answered after the draft was written. Nothing was sent.',
        reason: 'already_answered',
        approvable: true,
      },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        const d = describeApiError(err);
        assert.equal(d.status, 409);
        assert.equal(d.reason, 'already_answered');
        // The draft survives, so the UI must keep offering it.
        assert.equal(d.draftSurvives, true);
        assert.match(d.message, /Nothing was sent/);
        return true;
      }
    );
  });

  test('a superseded draft reports its own reason', async () => {
    responder = () => ({
      status: 409,
      data: {
        success: false,
        message: 'This customer sent another message after the draft was written.',
        reason: 'superseded',
        approvable: true,
      },
    });
    await assert.rejects(
      () => aiApi.approveJob('j1'),
      (err) => {
        assert.equal(describeApiError(err).reason, 'superseded');
        assert.equal(describeApiError(err).draftSurvives, true);
        return true;
      }
    );
  });
});
