// The API base URL (VITE_API_URL). Every backend route is under /api, so a
// build pointed at the bare API host — the mistake that made production call
// https://sms-api.webinfoys.com/auth/login — is corrected rather than shipped.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';

import { resolveApiBase } from '../src/utils/apiBase.js';

const PROD_API = 'https://sms-api.webinfoys.com';

describe('resolveApiBase', () => {
  test('the production API host given WITHOUT /api gets it added', () => {
    assert.equal(resolveApiBase(PROD_API), `${PROD_API}/api`);
    assert.equal(resolveApiBase(`${PROD_API}/`), `${PROD_API}/api`);
    assert.equal(resolveApiBase(`  ${PROD_API}//  `), `${PROD_API}/api`);
  });

  test('the correct value is left alone', () => {
    assert.equal(resolveApiBase(`${PROD_API}/api`), `${PROD_API}/api`);
    assert.equal(resolveApiBase(`${PROD_API}/api/`), `${PROD_API}/api`);
  });

  test('unset or blank means the relative /api the dev server proxies', () => {
    for (const blank of [undefined, null, '', '   ']) assert.equal(resolveApiBase(blank), '/api');
    assert.equal(resolveApiBase('/api'), '/api');
    assert.equal(resolveApiBase('/api/'), '/api');
  });

  test('a host with a port, and a deliberately different path, are respected', () => {
    assert.equal(resolveApiBase('http://localhost:5000'), 'http://localhost:5000/api');
    assert.equal(resolveApiBase('https://example.com/backend/v2'), 'https://example.com/backend/v2');
  });

  test('it never produces a doubled or missing slash', () => {
    for (const raw of [PROD_API, `${PROD_API}/`, `${PROD_API}/api`, `${PROD_API}/api/`]) {
      assert.equal(/\/api$/.test(resolveApiBase(raw)), true, raw);
      assert.equal(resolveApiBase(raw).includes('/api/api'), false, raw);
    }
  });
});

describe('the login request goes to /api/auth/login on the API host', () => {
  // An axios instance built exactly as src/services/api.js builds it, for the
  // value production was deployed with.
  const urlFor = (viteApiUrl, path) => {
    const client = axios.create({ baseURL: resolveApiBase(viteApiUrl) });
    return client.getUri({ url: path });
  };

  test('with the bare host that production was built with', () => {
    assert.equal(urlFor(PROD_API, '/auth/login'), `${PROD_API}/api/auth/login`);
  });

  test('and with the documented value', () => {
    assert.equal(urlFor(`${PROD_API}/api`, '/auth/login'), `${PROD_API}/api/auth/login`);
    assert.equal(urlFor(`${PROD_API}/api`, '/conversations/unread-count'), `${PROD_API}/api/conversations/unread-count`);
  });

  test('the API client uses the helper, and sends no cookies (bearer token only)', () => {
    const src = readFileSync(new URL('../src/services/api.js', import.meta.url), 'utf8');
    assert.match(src, /baseURL: resolveApiBase\(import\.meta\.env\.VITE_API_URL\)/);
    assert.doesNotMatch(src, /withCredentials/);
  });
});
