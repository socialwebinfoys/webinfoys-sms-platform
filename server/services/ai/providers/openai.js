// OpenAI adapter (Phase 8).
//
// Each adapter does exactly three things: build the vendor's request shape,
// perform the call, and return the model's RAW TEXT plus token usage. Deciding
// what that text means is responseParser's job, not the adapter's — that way a
// new provider needs no change to the parser, the guardrails or the worker.
'use strict';

const { ProviderError, kindForStatus, kindForNetworkError, safeDetail } = require('./errors');

const NAME = 'openai';
const DEFAULT_MODEL = 'gpt-4o-mini';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// `fetch` is injectable so tests can drive every branch without a network.
async function generate({ apiKey, model, system, user, timeoutMs, fetchImpl = fetch }) {
  const body = {
    model: model || DEFAULT_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Low temperature: this is customer correspondence, not creative writing,
    // and a deterministic-ish reply is easier to review.
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };

  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(`OpenAI request failed: ${safeDetail(err.message, apiKey)}`, {
      kind: kindForNetworkError(err),
      provider: NAME,
    });
  }

  if (!res.ok) {
    const detail = safeDetail(await res.text().catch(() => ''), apiKey);
    throw new ProviderError(`OpenAI returned ${res.status}: ${detail}`, {
      kind: kindForStatus(res.status),
      provider: NAME,
      status: res.status,
    });
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new ProviderError('OpenAI returned a body that is not JSON', {
      kind: 'invalid_request',
      provider: NAME,
    });
  }

  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new ProviderError('OpenAI returned no message content', {
      kind: 'temporary',
      provider: NAME,
    });
  }

  return {
    provider: NAME,
    model: payload.model || body.model,
    text,
    usage: {
      promptTokens: payload?.usage?.prompt_tokens,
      completionTokens: payload?.usage?.completion_tokens,
      totalTokens: payload?.usage?.total_tokens,
    },
  };
}

module.exports = { name: NAME, defaultModel: DEFAULT_MODEL, generate };
