import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapse, collapsePolls, groupStep, pollIntervalMs } from '../lib/collapse.mjs';

const call = (method, path, status, atMs) => ({ method, path, status, atMs });

test('collapse folds consecutive identical calls with a count', () => {
  const out = collapse([
    call('GET', '/api/a', 200, 1), call('GET', '/api/a', 200, 2),
    call('GET', '/api/b', 200, 3), call('GET', '/api/a', 200, 4),
  ]);
  assert.deepEqual(out.map((c) => [c.path, c.count]), [['/api/a', 2], ['/api/b', 1], ['/api/a', 1]]);
});

test('collapsePolls folds consecutive single-endpoint groups and keeps timestamps', () => {
  const g = (atMs) => ({ kind: 'api', title: 'GET "/api/status"', atMs, calls: [call('GET', '/api/status', 200, atMs)] });
  const out = collapsePolls([g(0), g(1000), g(2000), g(3000),
    { kind: 'interact', title: 'Click', atMs: 4000, calls: [] }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].repeats, 4);
  assert.equal(out[0].callCount, 4);
  assert.deepEqual(out[0].ats, [0, 1000, 2000, 3000]);
});

test('collapsePolls folds repeated actions even when side lookups interleave', () => {
  const poll = (atMs, extra) => ({
    kind: 'api', title: 'GET "/api/v1/my-substrate"', atMs,
    calls: [call('GET', '/api/v1/my-substrate', 200, atMs), ...(extra ? [call('GET', '/api/checkout/session/x', 200, atMs + 10)] : [])],
  });
  const out = collapsePolls([poll(0, false), poll(1000, true), poll(2000, false), poll(3000, true)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].repeats, 4);
  assert.equal(out[0].callCount, 6);
  assert.equal(out[0].calls.length, 6);            // merged for endpoint frequency
});

test('endpointFreq ranks the dominant endpoint first', async () => {
  const { endpointFreq } = await import('../lib/collapse.mjs');
  const freq = endpointFreq([
    call('GET', '/api/a', 200, 0), call('GET', '/api/b', 200, 1), { ...call('GET', '/api/a', 200, 2), count: 3 },
  ]);
  assert.deepEqual(freq[0], { ep: 'GET /api/a', n: 4 });
});

test('groupStep: pre-action calls become "on load", the rest bucket per action', () => {
  const s = {
    startMs: 0, endMs: 10000,
    actions: [{ title: 'Click submit', atMs: 5000, kind: 'interact' }],
    downstream: [call('GET', '/api/page', 200, 100), call('POST', '/api/submit', 200, 6000)],
  };
  const groups = groupStep(s);
  assert.equal(groups[0].kind, 'load');
  assert.deepEqual(groups[0].calls.map((c) => c.path), ['/api/page']);
  assert.equal(groups[1].title, 'Click submit');
  assert.deepEqual(groups[1].calls.map((c) => c.path), ['/api/submit']);
});

test('groupStep with no actions puts all calls in one group', () => {
  const groups = groupStep({ startMs: 0, endMs: 1, actions: [], downstream: [call('GET', '/api/x', 200, 0)] });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].kind, 'load');
});

test('pollIntervalMs is the median gap', () => {
  assert.equal(pollIntervalMs([0, 1000, 2100, 3050]), 1000); // gaps 1000,1100,950 → median 1000
  assert.equal(pollIntervalMs([5]), 0);
});
