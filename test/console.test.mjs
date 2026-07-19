import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConsole, attachConsole, chaptersWithActions } from '../lib/trace-actions.mjs';
import { scrubText } from '../lib/enrich.mjs';
const trace = [
  { type: 'before', callId: 's1', method: 'test.step', title: '1. Load page', startTime: 1000 },
  { type: 'before', callId: 'p', method: 'pw:api', title: 'Create page', startTime: 1005 },
  { type: 'after', callId: 'p', endTime: 1006 },
  { type: 'console', messageType: 'log', text: 'app booted', location: { url: 'http://localhost/x' }, time: 1100 },
  { type: 'console', messageType: 'warning', text: 'preload as unsupported', location: { url: 'http://cdn/y' }, time: 1200 },
  { type: 'console', messageType: 'warning', text: 'preload as unsupported', location: { url: 'http://cdn/y' }, time: 1250 },
  { type: 'after', callId: 's1', endTime: 1500 },
  { type: 'before', callId: 's2', method: 'test.step', title: '2. Submit', startTime: 1600 },
  { type: 'console', messageType: 'error', text: 'Uncaught TypeError: x is undefined', location: { url: 'http://localhost/app.js' }, time: 1700 },
  { type: 'pageerror', error: { message: 'Boom!' }, time: 1750 },
  { type: 'console', messageType: 'endGroup', text: '{}', time: 1760 },
  { type: 'after', callId: 's2', endTime: 2000 },
].map((o) => JSON.stringify(o)).join('\n');
test('parseConsole keeps error/warning/log, maps pageerror→error, drops noise', () => {
  const evs = parseConsole(trace);
  assert.ok(!evs.map(e=>e.level).includes(undefined));
  assert.equal(evs.filter((e) => e.level === 'error').length, 2);
  assert.equal(evs.filter((e) => e.level === 'warning').length, 2);
  assert.equal(evs.filter((e) => e.level === 'log').length, 1);
  assert.ok(!evs.some((e) => e.text === '{}'));
});
test('attachConsole buckets into windows and folds dupes', () => {
  const { chapters } = chaptersWithActions(trace);
  assert.equal(chapters[0].console.find((e) => e.level === 'warning').count, 2);
  assert.equal(chapters[1].console.filter((e) => e.level === 'error').length, 2);
});
test('scrubText redacts secrets', () => {
  assert.doesNotMatch(scrubText('mmk_ABCDEF123456'), /mmk_ABCDEF/);
  assert.equal(scrubText('plain'), 'plain');
});
