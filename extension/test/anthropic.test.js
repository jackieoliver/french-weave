import { describe, test, expect } from 'bun:test';
import { ANTHROPIC_URL, DEFAULT_ANTHROPIC_DAILY_CAP_USD, callAnthropic, toAnthropicBody, toAnthropicSchema, thinkingFor, costOf, usageOf }
  from '../src/anthropic.js';
import { buildRequest } from '../src/gemini.js';
import * as candidates from '../src/candidates.js';
import * as freeform from '../src/prompt.js';
import { countAnthropic, anthropicToday, paidBlocked, clearPaidStop, countOpenRouter, openRouterToday } from '../src/quota.js';
import { anthropicText, openRouterText } from '../src/modelerror.js';
import { cleanSettings, DEFAULT_SETTINGS } from '../src/settings.js';
import { memoryStorage } from '../src/cache.js';

const KEY = 'sk-ant-synthetic-test-key';
const MODEL = 'claude-haiku-5-5';
const gemini = buildRequest({ system: 'SYS', user: 'Passages:\n[]', schema: candidates.RESPONSE_SCHEMA, thinkingLevel: 'low', model: MODEL });
// Every object in a schema, wherever it sits.
const objects = (s, out = []) => {
  if (Array.isArray(s)) s.forEach((x) => objects(x, out));
  else if (s && typeof s === 'object') { if (s.type === 'object') out.push(s); Object.values(s).forEach((x) => objects(x, out)); }
  return out;
};
const reply = (body, { status = 200, headers = {} } = {}) => ({ ok: status < 300, status, headers: { get: (h) => headers[h.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const USAGE = { input_tokens: 4000, output_tokens: 600, output_tokens_details: { thinking_tokens: 200 } };
const ok = (text = '{"passages":[]}', extra = {}) => reply({ type: 'message', role: 'assistant', model: MODEL, stop_reason: 'end_turn',
  content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }], usage: USAGE, ...extra });
const capture = (res) => {
  const sent = [];
  return { sent, fetchImpl: async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return typeof res === 'function' ? res() : res; } };
};

describe('anthropic.js request', () => {
  test('the chain request becomes a Messages body: system, user text, adaptive thinking at low effort, the schema as a json_schema format', () => {
    const body = toAnthropicBody(MODEL, gemini, { thinking: 'low' });
    expect(body).toEqual({
      model: MODEL, max_tokens: 8000, system: 'SYS', messages: [{ role: 'user', content: 'Passages:\n[]' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema: toAnthropicSchema(candidates.RESPONSE_SCHEMA) } },
    });
    expect(body).not.toHaveProperty('temperature'); // Haiku 5.5 refuses non-default sampling
  });
  test('structured outputs need every object closed; both designs\' schemas pass, keywords inside properties survive', () => {
    for (const schema of [candidates.RESPONSE_SCHEMA, freeform.RESPONSE_SCHEMA]) {
      const out = toAnthropicSchema(schema);
      expect(objects(out).length).toBe(objects(schema).length);
      expect(objects(out).every((o) => o.additionalProperties === false)).toBe(true);
      expect(objects(schema).some((o) => 'additionalProperties' in o)).toBe(false); // the shared schema is not changed
    }
    expect(toAnthropicSchema({ type: 'object', properties: { minimum: { type: 'integer', minimum: 1 }, list: { type: 'array', items: { type: 'string', maxLength: 9 }, minItems: 3 } },
      required: ['minimum'] })).toEqual({ type: 'object', properties: { minimum: { type: 'integer' }, list: { type: 'array', items: { type: 'string' } } },
      required: ['minimum'], additionalProperties: false });
  });
  test('thinking: "off" turns it off at low effort; a level is adaptive thinking at that effort', () => {
    expect(thinkingFor('off')).toEqual({ thinking: { type: 'disabled' }, effort: 'low' });
    expect(thinkingFor('low')).toEqual({ thinking: { type: 'adaptive' }, effort: 'low' });
    expect(thinkingFor('medium')).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' });
    expect(thinkingFor('bogus').effort).toBe('low');
  });
  test('one POST to the Messages API: key in x-api-key only, version and direct-browser headers, the step\'s timeout', async () => {
    const { sent, fetchImpl } = capture(ok());
    const timeouts = [];
    const real = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return real.call(AbortSignal, ms); };
    try {
      await callAnthropic({ fetchImpl, apiKey: KEY, model: MODEL, body: gemini, thinking: 'low', timeoutMs: 35000 });
    } finally {
      AbortSignal.timeout = real;
    }
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe(ANTHROPIC_URL);
    expect(sent[0].init.method).toBe('POST');
    expect(sent[0].init.headers).toEqual({ 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true' });
    expect(sent[0].init.body).not.toContain(KEY);
    expect(sent[0].body.model).toBe(MODEL);
    expect(timeouts).toEqual([35000]);
  });
});

describe('anthropic.js reply', () => {
  test('text from the text blocks only (thinking blocks come first and are skipped), with usage and cost', async () => {
    const r = await callAnthropic({ fetchImpl: capture(ok('{"passages":[{"id":"a"}]}')).fetchImpl, apiKey: KEY, model: MODEL, body: gemini });
    expect(r.text).toBe('{"passages":[{"id":"a"}]}');
    expect(r.usage).toEqual({ promptTokens: 4000, answerTokens: 400, thinkingTokens: 200 });
    expect(r.costUsd).toBeCloseTo((4000 * 0.10 + 600 * 0.50) / 1e6, 10); // $0.0007: thinking bills as output
  });
  test('cost at the published Haiku 5.5 price: cache reads and writes, and the higher card past 100,000 prompt tokens', () => {
    expect(costOf(MODEL, { input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000, output_tokens: 1000 }))
      .toBeCloseTo((1000 * 0.10 + 1000 * 0.125 + 1000 * 0.01 + 1000 * 0.50) / 1e6, 10);
    expect(costOf(MODEL, { input_tokens: 100001, output_tokens: 1000 })).toBeCloseTo((100001 * 0.50 + 1000 * 2.50) / 1e6, 10);
    expect(costOf('another-model', USAGE)).toBe(0);
    expect(usageOf({ input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 })).toEqual({ promptTokens: 15, answerTokens: 3, thinkingTokens: 0 });
  });
  test('a refusal or a reply cut at max_tokens throws, still carrying what it cost', async () => {
    for (const stop of ['refusal', 'max_tokens']) {
      const e = await callAnthropic({ fetchImpl: capture(ok('', { stop_reason: stop })).fetchImpl, apiKey: KEY, model: MODEL, body: gemini }).catch((x) => x);
      expect(e.message).toBe(`Anthropic stopped: ${stop}`);
      expect(e.costUsd).toBeGreaterThan(0);
    }
  });
  test('errors: 401 and 403 refuse the key, 402 and "credit balance is too low" mean no credit; nothing of the body or key in the message', async () => {
    const err = (status, body, headers) => callAnthropic({ fetchImpl: capture(reply(body, { status, headers })).fetchImpl, apiKey: KEY, model: MODEL, body: gemini })
      .catch((e) => e);
    const low = { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } };
    expect(await err(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${KEY}` } }))
      .toMatchObject({ status: 401, keyRejected: true, message: 'HTTP 401' });
    expect(await err(403, { type: 'error', error: { type: 'permission_error', message: 'no' } })).toMatchObject({ status: 403, keyRejected: true });
    expect(await err(400, low)).toMatchObject({ status: 400, credits: true, message: 'HTTP 400' });
    expect(await err(402, { type: 'error', error: { type: 'billing_error', message: 'x' } })).toMatchObject({ status: 402, credits: true });
    expect((await err(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } })).credits).toBeUndefined();
    expect(await err(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } }, { 'retry-after': '12' })).toMatchObject({ status: 429, retryAfterMs: 12000 });
    expect(await err(529, 'not json')).toMatchObject({ status: 529 });
    expect(String((await err(401, `{"error":{"message":"${KEY}"}}`)).message)).not.toContain(KEY);
  });
  test('no connection is marked as network', async () => {
    const e = await callAnthropic({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, apiKey: KEY, model: MODEL, body: gemini }).catch((x) => x);
    expect(e.network).toBe(true);
  });
});

describe('Anthropic spend', () => {
  test('its own day record and cap (default $5.00): a refused key, no credit or the cap stop it; a new key clears a stop', async () => {
    expect(DEFAULT_ANTHROPIC_DAILY_CAP_USD).toBe(5);
    expect(DEFAULT_SETTINGS.anthropicDailyUsd).toBe(5);
    expect(cleanSettings({}).anthropicDailyUsd).toBe(5);
    expect(cleanSettings({ anthropicDailyUsd: 0.5 }).anthropicDailyUsd).toBe(0.5);
    expect(cleanSettings({ anthropicDailyUsd: 500 }).anthropicDailyUsd).toBe(5);
    expect(cleanSettings({}).openRouterDailyUsd).toBe(0.25); // OpenRouter's cap unchanged
    const storage = memoryStorage();
    await countAnthropic(storage, { costUsd: 4.999, status: 200 }, '2026-10-17');
    expect(paidBlocked(await anthropicToday(storage, '2026-10-17'), 5)).toBe('');
    await countAnthropic(storage, { costUsd: 0.002, status: 200 }, '2026-10-17');
    expect(paidBlocked(await anthropicToday(storage, '2026-10-17'), 5)).toBe('cap');
    expect(paidBlocked(await anthropicToday(storage, '2026-10-18'), 5)).toBe(''); // a new day
    expect(await openRouterToday(storage, '2026-10-17')).toMatchObject({ usd: 0 }); // kept apart from OpenRouter's
    await countAnthropic(storage, { costUsd: 0, status: 400, credits: true }, '2026-10-18');
    expect(paidBlocked(await anthropicToday(storage, '2026-10-18'), 5)).toBe('credits');
    await countAnthropic(storage, { costUsd: 0, status: 401 }, '2026-10-18');
    expect(paidBlocked(await anthropicToday(storage, '2026-10-18'), 5)).toBe('key');
    await countOpenRouter(storage, { costUsd: 0, status: 401 }, '2026-10-18');
    const realDay = (await anthropicToday(storage)).day;
    await countAnthropic(storage, { status: 403 });
    await clearPaidStop(storage, 'anthropic');
    expect(await anthropicToday(storage)).toMatchObject({ day: realDay, stopped: '' });
  });
  test('the popup line', () => {
    expect(anthropicText({}, 5)).toContain('Optional, paid: Claude Haiku 5.5 goes first at Levels 1-2, straight to Anthropic');
    expect(anthropicText({ hostAnthropicKey: true, anthropic: { usd: 0.0123, blocked: '' } }, 5)).toBe('Anthropic today: $0.0123 of $5.00');
    expect(anthropicText({ anthropicKey: true, anthropic: { usd: 5.01, blocked: 'cap' } }, 5)).toContain('Daily cap reached: stopped until tomorrow.');
    expect(anthropicText({ anthropicKey: true, anthropic: { usd: 0, blocked: 'credits' } }, 5)).toContain('Credit balance too low');
    expect(anthropicText({ anthropicKey: true, anthropic: { usd: 0, blocked: 'key' } }, 5)).toContain('Anthropic rejected the key');
    expect(openRouterText({}, 0.25)).toContain('direct instead with an Anthropic key');
  });
});
