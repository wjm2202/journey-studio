// Integration test for the dashboard drop path: PUT files + POST /api/ingest against a live server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function report(videoAbs) {
  return { suites: [{ title: 'x.spec.ts', file: 'x.spec.ts', specs: [{ title: 'does a thing',
    tests: [{ annotations: [{ type: 'guide', description: JSON.stringify({ objective: 'do-thing', title: 'Do thing', category: 'demo' }) }],
      results: [{ status: 'passed', attachments: [
        { name: 'video', path: videoAbs },
        { name: 'guide-timeline', contentType: 'application/json', body: Buffer.from(JSON.stringify({ chapters: [
          { id: 's01', index: 1, title: 'Step', hint: null, startMs: 0, endMs: 1000, testId: null, assertions: [] }] })).toString('base64') },
      ] }] }] }] }] };
}

async function waitUp(base, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const r = await fetch(base + '/'); if (r.ok || r.status === 404) return true; } catch {} await sleep(120); }
  return false;
}

test('dashboard drop path: PUT files + POST /api/ingest builds a batch', async () => {
  const work = mkdtempSync(path.join(tmpdir(), 'js-serve-'));
  const guides = path.join(work, 'guides'); mkdirSync(guides, { recursive: true });
  const port = 8800 + (process.pid % 90);
  const srv = spawn('node', [path.join(ROOT, 'bin/journey-studio.mjs'), 'serve', '--dir', guides, '--port', String(port)], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, BROWSER: 'true' } });
  try {
    // 127.0.0.1, NOT localhost: the server binds loopback IPv4 only, and Node 18's
    // fetch resolves localhost to ::1 without falling back to IPv4 (Node 20+ does).
    const base = `http://127.0.0.1:${port}`;
    assert.ok(await waitUp(base), 'server came up');
    const videoAbs = '/Users/x/proj/test-results/demo/video.webm';
    let r = await fetch(`${base}/api/upload?path=run1/results.json`, { method: 'PUT', body: JSON.stringify(report(videoAbs)) });
    assert.equal(r.status, 200, 'results.json uploaded');
    r = await fetch(`${base}/api/upload?path=run1/test-results/demo/video.webm`, { method: 'PUT', body: 'FAKEWEBM' });
    assert.equal(r.status, 200, 'video uploaded');
    // path traversal is rejected
    r = await fetch(`${base}/api/upload?path=../escape.txt`, { method: 'PUT', body: 'x' });
    assert.equal(r.status, 400, 'traversal rejected');
    r = await fetch(`${base}/api/ingest?batch=run1`, { method: 'POST' });
    assert.equal(r.status, 200, 'ingest ok');
    const entry = await r.json();
    assert.equal(entry.id, 'run1');
    assert.equal(entry.guideCount, 1);
    assert.equal(entry.missingVideos, 0, 'uploaded video resolved by rebasing');
    const idx = JSON.parse(readFileSync(path.join(guides, 'index.json'), 'utf8'));
    assert.equal(idx.batches.length, 1);
    assert.ok(existsSync(path.join(guides, 'run1', 'do-thing', 'guide.json')), 'guide written under the batch');

    // static GET advertises byte ranges and honours them (video seeking depends on this)
    r = await fetch(`${base}/run1/do-thing/raw.webm`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('accept-ranges'), 'bytes', 'Accept-Ranges advertised');
    assert.equal(Number(r.headers.get('content-length')), 8, 'full length declared');
    r = await fetch(`${base}/run1/do-thing/raw.webm`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(r.status, 206, 'partial content served');
    assert.equal(r.headers.get('content-range'), 'bytes 2-5/8');
    assert.equal(await r.text(), 'KEWE', 'exact byte slice returned');
    r = await fetch(`${base}/run1/do-thing/raw.webm`, { headers: { Range: 'bytes=99-' } });
    assert.equal(r.status, 416, 'out-of-range rejected');
    // narration-brief.md is served as markdown text, not a download
    r = await fetch(`${base}/run1/do-thing/narration-brief.md`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/markdown/, '.md served as text');

    // health endpoint advertises server features (UI uses it to detect an outdated process)
    r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    const health = await r.json();
    assert.ok(health.features.includes('remove') && health.features.includes('range'), 'features advertised');

    // ingest writes an explicit initial state (no 404 per guide on the dashboard)
    r = await fetch(`${base}/run1/do-thing/state.json`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).state, 'captured');

    // an ABORTED video request (every seek does this) must not kill the server
    const ac = new AbortController();
    const partial = fetch(`${base}/run1/do-thing/raw.webm`, { headers: { Range: 'bytes=0-' }, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await partial.catch(() => {});
    await sleep(150);
    r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200, 'server survived the aborted stream');

    // AI review pack: filtered slice of the batch as one markdown fetch
    r = await fetch(`${base}/api/review?batch=run1&filter=passed`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/markdown/);
    const review = await r.text();
    assert.ok(review.includes('## PASSED — does a thing'), 'per-spec section present');
    assert.ok(review.includes('- bundle: run1/do-thing/guide.json'), 'links to the bundle');
    r = await fetch(`${base}/api/review?batch=run1&filter=failed`);
    assert.ok((await r.text()).includes('No specs match'), 'empty filter states itself');
    r = await fetch(`${base}/api/review?batch=nope`);
    assert.equal(r.status, 404);

    // soft-remove endpoint: guide then whole batch → moved to _to_delete/, index updated
    r = await fetch(`${base}/api/remove?batch=run1&slug=do-thing`, { method: 'POST' });
    assert.equal(r.status, 200, 'guide removed');
    assert.ok(!existsSync(path.join(guides, 'run1', 'do-thing')), 'guide folder moved out');
    r = await fetch(`${base}/api/remove?batch=run1`, { method: 'POST' });
    assert.equal(r.status, 200, 'batch removed');
    const idx2 = JSON.parse(readFileSync(path.join(guides, 'index.json'), 'utf8'));
    assert.equal(idx2.batches.length, 0, 'index empty after batch removal');
    assert.ok(existsSync(path.join(guides, '_to_delete')), 'everything landed in _to_delete/');
    r = await fetch(`${base}/api/remove?batch=nope`, { method: 'POST' });
    assert.equal(r.status, 404, 'unknown batch → 404');

    // UI pages are served LIVE from the package's web/, never the startup copy —
    // overwrite the guides-dir copy with junk and the server must not serve it
    writeFileSync(path.join(guides, 'studio.html'), 'STALE COPY');
    r = await fetch(`${base}/studio.html`);
    const html = await r.text();
    assert.notEqual(html, 'STALE COPY', 'stale guides copy ignored');
    assert.match(html, /Journey Studio — narrate/, 'live web/studio.html served');
  } finally { srv.kill('SIGKILL'); }
});
