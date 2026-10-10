// What the browser does when the seven-day token expires.
//
// The server answers 401. The real axios instance (src/services/api.js) is
// driven through a stub adapter here, so these are its actual interceptors:
// the stored session is cleared, the page goes to /login ONCE, and the failed
// request is rejected — never retried, never refreshed.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import axios from 'axios';

import api from '../src/services/api.js';

const source = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

let calls;
let respond;
let redirects;
api.defaults.adapter = async (config) => {
  calls.push({ method: config.method, url: config.url, authorization: config.headers.Authorization });
  const { status, data } = respond(config);
  const response = { status, statusText: String(status), data, headers: {}, config };
  if (status >= 200 && status < 300) return response;
  throw new axios.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, response);
};

const EXPIRED = { status: 401, data: { success: false, message: 'Not authorized: invalid token' } };

beforeEach(() => {
  calls = [];
  redirects = [];
  respond = () => ({ status: 200, data: { success: true } });
  localStorage.clear();
  localStorage.setItem('token', 'header.payload.signature');
  localStorage.setItem('user', JSON.stringify({ name: 'Operator', role: 'user' }));
  localStorage.setItem('webinfoys-theme', 'light');
  window.location = { pathname: '/inbox', assign: (to) => redirects.push(to) };
});

describe('while the token is valid', () => {
  test('every request carries it, and nothing is cleared or redirected', async () => {
    await api.get('/conversations');
    await api.post('/sms/send', { body: 'hi' });
    assert.deepEqual(calls.map((c) => c.authorization), ['Bearer header.payload.signature', 'Bearer header.payload.signature']);
    assert.equal(localStorage.getItem('token'), 'header.payload.signature');
    assert.deepEqual(redirects, []);
  });
});

describe('when the token has expired (the API answers 401)', () => {
  test('the stored session is cleared and the page goes to the login screen', async () => {
    respond = () => EXPIRED;
    await assert.rejects(() => api.get('/conversations'));
    assert.equal(localStorage.getItem('token'), null);
    assert.equal(localStorage.getItem('user'), null);
    assert.deepEqual(redirects, ['/login']);
  });

  test('the failed request is NOT retried — one call, one rejection', async () => {
    respond = () => EXPIRED;
    await assert.rejects(() => api.get('/conversations'), (err) => err.response.status === 401);
    assert.equal(calls.length, 1, 'no retry, so no loop');
  });

  test('no refresh or renewal request is made', async () => {
    respond = () => EXPIRED;
    await assert.rejects(() => api.get('/conversations'));
    assert.equal(calls.some((c) => /refresh|renew|token/.test(c.url)), false);
  });

  test('after the session is cleared, later requests carry no token', async () => {
    respond = () => EXPIRED;
    await assert.rejects(() => api.get('/conversations'));
    await assert.rejects(() => api.get('/conversations/unread-count'));
    assert.equal(calls[1].authorization, undefined);
  });

  test('several requests failing together (page load, polling) all settle; nothing loops', async () => {
    respond = () => EXPIRED;
    const results = await Promise.allSettled([
      api.get('/conversations'),
      api.get('/conversations/unread-count'),
      api.get('/conversations/changes'),
      api.get('/settings/inbox'),
    ]);
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.equal(calls.length, 4, 'each request was made exactly once');
    assert.ok(redirects.every((to) => to === '/login'));
    assert.equal(localStorage.getItem('token'), null);
  });

  test('already on the login page: no redirect, so a wrong password cannot cause a reload loop', async () => {
    window.location = { pathname: '/login', assign: (to) => redirects.push(to) };
    respond = () => ({ status: 401, data: { success: false, message: 'Invalid credentials' } });
    await assert.rejects(
      () => api.post('/auth/login', { email: 'a@b.c', password: 'wrong' }),
      (err) => err.response.data.message === 'Invalid credentials'
    );
    assert.deepEqual(redirects, []);
    assert.equal(calls.length, 1);
  });

  test('unrelated preferences (the theme) survive being signed out', async () => {
    respond = () => EXPIRED;
    await assert.rejects(() => api.get('/conversations'));
    assert.equal(localStorage.getItem('webinfoys-theme'), 'light');
  });

  test('other errors do not sign the user out', async () => {
    for (const status of [400, 403, 404, 409, 422, 500, 503]) {
      respond = () => ({ status, data: { success: false, message: 'x' } });
      await assert.rejects(() => api.get('/anything'));
    }
    assert.equal(localStorage.getItem('token'), 'header.payload.signature');
    assert.deepEqual(redirects, []);
  });
});

describe('the app has no refresh mechanism', () => {
  test('the API client has exactly one request and one response interceptor, and no retry', () => {
    const src = source('services/api.js');
    assert.equal(src.match(/interceptors\.request\.use/g).length, 1);
    assert.equal(src.match(/interceptors\.response\.use/g).length, 1);
    assert.doesNotMatch(src, /refresh|retry|_retry|api\(error\.config\)|api\.request\(/i);
  });

  test('the session is the token from login, kept until logout or a 401', () => {
    const src = source('context/AuthContext.jsx');
    assert.match(src, /api\.post\('\/auth\/login', \{ email, password \}\)/);
    assert.match(src, /localStorage\.setItem\('token', data\.token\)/);
    assert.doesNotMatch(src, /refresh|setInterval|setTimeout/i);
  });

  test('a visitor with no session is sent to /login by the route guard', () => {
    const src = source('components/ProtectedRoute.jsx');
    assert.match(src, /if \(!isAuthenticated\) \{\s*return <Navigate to="\/login" replace \/>;/);
  });
});
