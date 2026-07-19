// Integration test for the ./drop wrapper — runs it end-to-end (no-serve) over a temp inbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeInbox() {
  const inbox = mkdtempSync(path.join(tmpdir(), 'js-drop-inbox-'));
  const drop = path.join(inbox, 'my-run');
  const trDir = path.join(drop, 'test-results', 'demo');
  mkdirSync(trDir, { recursive: true });
  const videoAbs = path.join(trDir, 'video.webm');
  writeFileSync(videoAbs, 'FAKEWEBM');
  const report = { suites: [{ title: 'x.spec.ts', file: 'x.spec.ts', specs: [{ title: 'does a thing',
    tests: [{ annotations: [{ type: 'guide', description: JSON.stringify({ objective: 'do-thing', title: 'Do thing', category: 'demo' }) }],
      results: [{ status: 'passed', attachments: [
        { name: 'video', path: videoAbs, contentType: 'video/webm' },
        { name: 'guide-timeline', contentType: 'application/json', body: Buffer.from(JSON.stringify({ chapters: [
          { id: 's01', index: 1, title: 'Step', hint: null, startMs: 0, endMs: 1000, testId: null, assertions: [] }] })).toString('base64') },
      ] }] }] }] }] };
  writeFileSync(path.join(drop, 'results.json'), JSON.stringify(report));
  return inbox;
}

test('./drop ingests the inbox and writes index.json (no-serve)', () => {
  const inbox = makeInbox();
  const out = mkdtempSync(path.join(tmpdir(), 'js-drop-out-'));
  execFileSync(path.join(ROOT, 'drop'), ['--out', out, '--no-serve'], {
    cwd: ROOT, env: { ...process.env, JOURNEY_INBOX: inbox }, encoding: 'utf8',
  });
  const idx = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
  assert.equal(idx.batches.length, 1);
  assert.equal(idx.batches[0].id, 'my-run');
  assert.equal(idx.batches[0].guideCount, 1);
  assert.ok(existsSync(path.join(out, 'my-run', 'do-thing', 'guide.json')), 'guide built via wrapper');
});
