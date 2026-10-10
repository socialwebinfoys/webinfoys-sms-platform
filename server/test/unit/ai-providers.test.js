// Phase 8 — provider adapters and the registry.
//
// Every adapter is driven through an injected `fetch`, so all three are
// exercised across success and each failure class with no network call, no
// credential and no cost.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../../services/ai/providers');
const openai = require('../../services/ai/providers/openai');
const groq = require('../../services/ai/providers/groq');
const gemini = require('../../services/ai/providers/gemini');
const { KINDS, RETRYABLE_KINDS, safeDetail } = require('../../services/ai/providers/errors');

const ARGS = {
  apiKey: 'test-key-never-real',
  system: 'you are a test',
  user: 'hello',
  timeoutMs: 1000,
};

// Minimal fetch doubles.
const okJson = (payload) => async () => ({
  ok: true,
  status: 200,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});
const httpError = (status, body = 'upstream said no') => async () => ({
  ok: false,
  status,
  json: async () => ({}),
  text: async () => body,
});
const throwsNetwork = (name) => async () => {
  const err = new Error('boom');
  err.name = name;
  throw err;
};

const OPENAI_OK = {
  model: 'gpt-4o-mini',
  choices: [{ message: { content: '{"reply":"hi","confidence":0.9,"escalate":false}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};
const GROQ_OK = {
  model: 'llama-3.3-70b-versatile',
  choices: [{ message: { content: '{"reply":"hey","confidence":0.8,"escalate":false}' } }],
  usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
};
const GEMINI_OK = {
  candidates: [{ content: { parts: [{ text: '{"reply":"hello","confidence":0.7,"escalate":false}' }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, totalTokenCount: 15 },
};

const ADAPTERS = [
  { name: 'openai', adapter: openai, ok: OPENAI_OK, expectedText: '{"reply":"hi","confidence":0.9,"escalate":false}' },
  { name: 'groq', adapter: groq, ok: GROQ_OK, expectedText: '{"reply":"hey","confidence":0.8,"escalate":false}' },
  { name: 'gemini', adapter: gemini, ok: GEMINI_OK, expectedText: '{"reply":"hello","confidence":0.7,"escalate":false}' },
];

describe('registry', () => {
  test('exposes exactly the three required providers', () => {
    assert.deepEqual([...providers.PROVIDER_NAMES].sort(), ['gemini', 'groq', 'openai']);
  });

  test('isSupported', () => {
    for (const name of ['openai', 'groq', 'gemini']) assert.equal(providers.isSupported(name), true);
    for (const name of ['claude', '', null, undefined, 'OpenAI']) {
      assert.equal(providers.isSupported(name), false);
    }
  });

  test('an unknown provider is a clean 400, listing what is supported', () => {
    assert.throws(() => providers.getAdapter('nope'), (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /gemini, groq, openai|openai, groq, gemini/);
      return true;
    });
  });

  test('every adapter exposes the same interface', () => {
    for (const name of providers.PROVIDER_NAMES) {
      const adapter = providers.getAdapter(name);
      assert.equal(typeof adapter.generate, 'function');
      assert.equal(typeof adapter.defaultModel, 'string');
      assert.ok(adapter.defaultModel.length > 0);
      assert.equal(adapter.name, name);
    }
  });

  test('an adapter can be swapped for a test without touching the workflow', () => {
    const fake = { name: 'openai', defaultModel: 'fake', generate: async () => ({ text: '{}' }) };
    providers.__setAdapter('openai', fake);
    assert.equal(providers.getAdapter('openai'), fake);
    providers.__reset();
    assert.notEqual(providers.getAdapter('openai'), fake);
  });
});

describe('each adapter normalises a successful response', () => {
  for (const { name, adapter, ok, expectedText } of ADAPTERS) {
    test(`${name}: returns provider, model, text and usage`, async () => {
      const result = await adapter.generate({ ...ARGS, fetchImpl: okJson(ok) });
      assert.equal(result.provider, name);
      assert.ok(result.model);
      assert.equal(result.text, expectedText);
      assert.equal(result.usage.promptTokens > 0, true);
      assert.equal(result.usage.totalTokens > 0, true);
    });

    test(`${name}: uses its default model when none is configured`, async () => {
      let captured = null;
      const spy = async (url, init) => {
        captured = { url, init };
        return (await okJson(ok)())
      };
      await adapter.generate({ ...ARGS, model: '', fetchImpl: spy });
      const sentModel = name === 'gemini' ? captured.url : JSON.parse(captured.init.body).model;
      assert.ok(String(sentModel).includes(adapter.defaultModel));
    });

    test(`${name}: sends the api key in a header, never in the URL`, async () => {
      let captured = null;
      const spy = async (url, init) => {
        captured = { url, init };
        return (await okJson(ok)())
      };
      await adapter.generate({ ...ARGS, fetchImpl: spy });
      assert.equal(
        captured.url.includes(ARGS.apiKey),
        false,
        'a key in the URL would reach proxy and access logs'
      );
      const headerValues = Object.values(captured.init.headers).join(' ');
      assert.ok(headerValues.includes(ARGS.apiKey));
    });
  }
});

describe('each adapter classifies failures identically', () => {
  const cases = [
    [401, KINDS.AUTH],
    [403, KINDS.AUTH],
    [429, KINDS.RATE_LIMIT],
    [400, KINDS.INVALID_REQUEST],
    [404, KINDS.INVALID_REQUEST],
    [422, KINDS.INVALID_REQUEST],
    [500, KINDS.TEMPORARY],
    [503, KINDS.TEMPORARY],
  ];

  for (const { name, adapter } of ADAPTERS) {
    for (const [status, expectedKind] of cases) {
      test(`${name}: HTTP ${status} -> ${expectedKind}`, async () => {
        await assert.rejects(
          () => adapter.generate({ ...ARGS, fetchImpl: httpError(status) }),
          (err) => {
            assert.equal(err.kind, expectedKind);
            assert.equal(err.provider, name);
            assert.equal(err.status, status);
            return true;
          }
        );
      });
    }

    test(`${name}: an aborted request is a timeout, and is retryable`, async () => {
      await assert.rejects(
        () => adapter.generate({ ...ARGS, fetchImpl: throwsNetwork('AbortError') }),
        (err) => {
          assert.equal(err.kind, KINDS.TIMEOUT);
          assert.equal(err.retryable, true);
          return true;
        }
      );
    });

    test(`${name}: a network error is temporary, and is retryable`, async () => {
      await assert.rejects(
        () => adapter.generate({ ...ARGS, fetchImpl: throwsNetwork('TypeError') }),
        (err) => {
          assert.equal(err.kind, KINDS.TEMPORARY);
          assert.equal(err.retryable, true);
          return true;
        }
      );
    });

    test(`${name}: an auth failure is NOT retryable`, async () => {
      await assert.rejects(
        () => adapter.generate({ ...ARGS, fetchImpl: httpError(401) }),
        (err) => {
          assert.equal(err.retryable, false, 'retrying a bad key just burns attempts');
          return true;
        }
      );
    });

    test(`${name}: a non-JSON body is rejected`, async () => {
      const notJson = async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json');
        },
        text: async () => 'not json',
      });
      await assert.rejects(() => adapter.generate({ ...ARGS, fetchImpl: notJson }));
    });

    test(`${name}: an empty completion is rejected rather than returned`, async () => {
      const empty =
        name === 'gemini'
          ? { candidates: [{ content: { parts: [{ text: '  ' }] } }] }
          : { choices: [{ message: { content: '' } }] };
      await assert.rejects(() => adapter.generate({ ...ARGS, fetchImpl: okJson(empty) }));
    });
  }
});

describe('gemini-specific handling', () => {
  test('a safety block is reported as a definitive refusal, not a blip', async () => {
    const blocked = okJson({ promptFeedback: { blockReason: 'SAFETY' } });
    await assert.rejects(() => gemini.generate({ ...ARGS, fetchImpl: blocked }), (err) => {
      assert.equal(err.kind, KINDS.INVALID_REQUEST);
      assert.match(err.message, /blocked/i);
      return true;
    });
  });

  test('multi-part candidate text is joined', async () => {
    const multi = okJson({
      candidates: [{ content: { parts: [{ text: '{"reply":"a' }, { text: 'b","confidence":1}' }] } }],
    });
    const result = await gemini.generate({ ...ARGS, fetchImpl: multi });
    assert.equal(result.text, '{"reply":"ab","confidence":1}');
  });
});

describe('error detail is scrubbed before it is kept', () => {
  test('key-shaped tokens are redacted from provider error text', () => {
    const detail = safeDetail('Invalid key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789 supplied');
    assert.equal(detail.includes('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'), false);
    assert.match(detail, /\[redacted\]/);
  });

  test('detail is length-capped', () => {
    assert.ok(safeDetail('x'.repeat(5000)).length <= 200);
  });

  test('a provider error message never carries the api key', async () => {
    const echoesKey = httpError(401, `bad key ${ARGS.apiKey}`);
    await assert.rejects(() => openai.generate({ ...ARGS, fetchImpl: echoesKey }), (err) => {
      assert.equal(err.message.includes(ARGS.apiKey), false);
      return true;
    });
  });
});

describe('retry classification', () => {
  test('only temporary, rate-limit and timeout are retryable', () => {
    assert.deepEqual([...RETRYABLE_KINDS].sort(), ['rate_limit', 'temporary', 'timeout']);
    for (const kind of [KINDS.AUTH, KINDS.INVALID_REQUEST, KINDS.PERMANENT]) {
      assert.equal(RETRYABLE_KINDS.has(kind), false);
    }
  });
});
