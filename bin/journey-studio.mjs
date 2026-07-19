#!/usr/bin/env node
/**
 * journey-studio — turn Playwright test results into narrated how-to guides.
 *
 *   journey-studio <results.json>                     build one report + open dashboard
 *   journey-studio build <results.json> [--out ./guides]
 *   journey-studio ingest [--inbox ./inbox] [--out ./guides] [--openapi <spec.json>]
 *   journey-studio ingest --from <report-folder> [--batch <id>] [--openapi <spec.json>]
 *   journey-studio serve [--dir ./guides] [--port 8777]
 *   journey-studio splice <slug> [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]
 *
 * DROP MODEL: drop a Playwright report folder onto the dashboard (or `ingest --from`).
 * Each folder becomes a BATCH under guides/<id>/, recorded in guides/index.json — the
 * browsable folder index. The dashboard drop zone uploads files to /api/upload then
 * triggers /api/ingest, both served here.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFromReport } from '../lib/build-core.mjs';
import { enrichGuide, enrichStats, scrubText } from '../lib/enrich.mjs';
import { chaptersWithActions } from '../lib/trace-actions.mjs';
import { buildBrief, buildReview } from '../lib/brief.mjs';
import { extractNetworkText, extractTraceText, ingestFolder, ingestInbox, writeIndex, removeBatch, removeGuide } from '../lib/ingest.mjs';
import { newNote, addNote, updateNote, removeNote } from '../lib/feedback.mjs';
import { splice } from '../lib/splice.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--inbox') a.inbox = argv[++i];
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--batch') a.batch = argv[++i];
    else if (t === '--openapi') a.openapi = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--host') a.host = argv[++i];
    else if (t === '--rate') a.rate = Number(argv[++i]);
    else if (t === '--band') a.band = Number(argv[++i]);
    else if (t === '--fps') a.fps = Number(argv[++i]);
    else if (t === '--crf') a.crf = argv[++i];
    else if (t === '--preset') a.preset = argv[++i];
    else if (t === '--add-intro') a.addIntro = argv[++i];
    else if (t === '--intro') a.intro = argv[++i];
    else if (t === '--no-serve') a.serve = false;
    else a._.push(t);
  }
  return a;
}

function ffprobeMs(file) {
  try {
    const s = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : 0;
  } catch { return 0; }
}

function copyWeb(outDir) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(PKG, 'web', 'dashboard.html'), path.join(outDir, 'dashboard.html'));
  copyFileSync(path.join(PKG, 'web', 'studio.html'), path.join(outDir, 'studio.html'));
  try { copyFileSync(path.join(PKG, 'web', 'feedback.html'), path.join(outDir, 'feedback.html')); } catch {}
}

/** Reject path traversal; return a safe forward-slash relative path or null. */
function sanitizeRel(rel) {
  const n = path.posix.normalize(String(rel).replace(/\\/g, '/'));
  if (!n || n === '.' || n.startsWith('..') || n.startsWith('/') || n.includes('/../')) return null;
  return n;
}

function build(resultsPath, outDir, openapiPath) {
  if (!existsSync(resultsPath)) { console.error(`✗ no results file at ${resultsPath}`); process.exit(1); }
  const report = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const openapi = openapiPath && existsSync(openapiPath) ? JSON.parse(readFileSync(openapiPath, 'utf8')) : null;

  const durations = {};
  let missing = 0;
  for (const g of buildFromReport(report).guides) {
    const dir = path.join(outDir, g.slug);
    mkdirSync(dir, { recursive: true });
    if (g.videoPath && existsSync(g.videoPath)) { const dest = path.join(dir, 'raw.webm'); copyFileSync(g.videoPath, dest); durations[g.slug] = ffprobeMs(dest); }
    else if (g.videoPath) missing++;
    if (g.tracePath && existsSync(g.tracePath)) copyFileSync(g.tracePath, path.join(dir, 'trace.zip'));
  }

  const { guides, registry } = buildFromReport(report, { durations });
  for (const g of guides) {
    const dir = path.join(outDir, g.slug);
    let bundle = {
      objective: g.slug, title: g.meta.title, category: g.meta.category ?? 'uncategorized',
      assumes: g.meta.assumes ?? [], journeyRef: g.meta.journeyRef ?? null, specFile: g.file ?? null,
      annotated: g.annotated, video: g.videoPath ? `${g.slug}/raw.webm` : null,
      durationMs: g.durationMs, aligned: g.aligned, steps: g.steps,
    };
    const traceZip = path.join(dir, 'trace.zip');
    const networkText = extractNetworkText(traceZip);
    let t0;
    if (!bundle.steps.length) {                    // mirror of ingestFolder's trace-mining path
      const { chapters, t0: videoStart } = chaptersWithActions(extractTraceText(traceZip), { videoMs: durations[g.slug] || 0 });
      bundle.steps = chapters.map((c) => ({
        id: c.id, index: c.index, title: c.title, hint: c.hint ?? null, ...(c.post ? { post: true } : {}),
        startMs: c.startMs, endMs: c.endMs, testId: null,
        assertions: c.assertions ?? [], checks: c.checks ?? [], sees: c.sees ?? null,
        messages: c.messages ?? [], actions: c.actions ?? [], downstream: [],
        console: (c.console ?? []).map((e) => ({ ...e, text: scrubText(e.text) })), narration: null,
      }));
      t0 = videoStart;
    }
    bundle = enrichGuide(bundle, { networkText, openapi, startMs: t0 });
    const ds = enrichStats(bundle);
    writeFileSync(path.join(dir, 'guide.json'), JSON.stringify(bundle, null, 2));
    writeFileSync(path.join(dir, 'narration-brief.md'), buildBrief(bundle, { fingerprint: g.fingerprint }));
    writeFileSync(path.join(dir, 'journey.fingerprint.json'), JSON.stringify(
      { schema: 'journey-fingerprint/v1', slug: g.slug, hash: g.fingerprint, steps: g.steps.map((s) => ({ title: s.title, testId: s.testId, assertions: s.assertions })) }, null, 2));
    console.log(`  ${g.annotated ? '★' : '·'} ${g.slug}  ${g.steps.length} steps  ${g.durationMs}ms  aligned=${g.aligned}  downstream=${ds.total}`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'registry.json'), JSON.stringify(registry, null, 2));
  copyWeb(outDir);
  console.log(`\n✓ ${Object.keys(registry).length} guide(s) → ${outDir}${missing ? `  (${missing} video path(s) not found here — run where the tests ran)` : ''}`);
  return outDir;
}

function ingest(args) {
  const out = path.resolve(args.out ?? 'guides');
  const openapiPath = args.openapi ? path.resolve(args.openapi) : null;
  const now = nowIso();
  const opts = { out, openapiPath, now, log: (m) => console.log(m) };
  let entries;
  if (args.from) {
    console.log(`▒ ingesting folder ${args.from}`);
    const entry = ingestFolder(path.resolve(args.from), { ...opts, batchId: args.batch });
    writeIndex(out, entry);
    entries = [entry];
  } else {
    const inbox = path.resolve(args.inbox ?? 'inbox');
    if (!existsSync(inbox)) { console.error(`✗ no inbox at ${inbox} — create it and drop Playwright report folders inside, or use --from <folder>`); process.exit(1); }
    console.log(`▒ scanning inbox ${inbox}`);
    entries = ingestInbox(inbox, opts);
  }
  copyWeb(out);
  const guides = entries.reduce((n, e) => n + e.guideCount, 0);
  console.log(`\n✓ ${entries.length} folder(s), ${guides} guide(s) → ${out}`);
  for (const e of entries) console.log(`   • ${e.id}  (${e.guideCount} guide${e.guideCount === 1 ? '' : 's'})${e.missingVideos ? `  ⚠ ${e.missingVideos} video(s) not found here` : ''}`);
  if (args.serve !== false) serve(out, args.port ?? 8777, args.host);
  return out;
}

const TYPES = { '.html': 'text/html', '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4', '.js': 'text/javascript', '.css': 'text/css', '.srt': 'text/plain', '.vtt': 'text/vtt', '.md': 'text/markdown; charset=utf-8' };

function readBody(req) {
  return new Promise((resolve, reject) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => resolve(Buffer.concat(p))); req.on('error', reject); });
}

// SECURITY DEFAULT: bind loopback only. This server can upload, ingest and
// soft-remove files — it must not be reachable from the LAN unless the user
// explicitly opts in with --host 0.0.0.0.
function serve(dir, port, host = '127.0.0.1', tries = 0) {
  const root = path.resolve(dir);
  const INBOX = path.resolve(root, '..', 'inbox');           // drop-zone staging (sibling of guides/)
  const OPENAPI = process.env.JOURNEY_OPENAPI ? path.resolve(process.env.JOURNEY_OPENAPI) : null;
  copyWeb(root);                                             // ensure the dashboard is always present

  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);

    // ── drop zone: stage one uploaded file into inbox/<rel> ──
    if (req.method === 'PUT' && pathname === '/api/upload') {
      const safe = sanitizeRel(u.searchParams.get('path') || '');
      if (!safe) { res.writeHead(400); res.end('bad path'); return; }
      const dest = path.join(INBOX, safe);
      if (!dest.startsWith(INBOX + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      try { const body = await readBody(req); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, body); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    // ── drop zone: ingest a staged batch, refresh the index ──
    if (req.method === 'POST' && pathname === '/api/ingest') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const src = batch && path.join(INBOX, batch);
      if (!batch || !existsSync(src)) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'no staged files for that batch' })); return; }
      try {
        const entry = ingestFolder(src, { out: root, openapiPath: OPENAPI, batchId: batch, now: nowIso() });
        writeIndex(root, entry);
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(entry));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      return;
    }
    // ── health/version: lets the live-served UI detect an OUTDATED server process ──
    if (req.method === 'GET' && pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, features: ['range', 'live-web', 'remove', 'upload', 'ingest', 'notes', 'health', 'review'] }));
      return;
    }
    // ── AI review pack: a FILTERED result set as one markdown fetch ──
    // Give this URL to an AI: /api/review?batch=<id>&filter=failed
    if (req.method === 'GET' && pathname === '/api/review') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const f = u.searchParams.get('filter') || 'all';
      const filter = ['all', 'passed', 'failed', 'skipped'].includes(f) ? f : 'all';
      let index = null; try { index = JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')); } catch {}
      const entry = index && (index.batches || []).find((b) => b.id === batch);
      if (!entry) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown batch' })); return; }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buildReview(entry, filter));
      return;
    }
    // ── soft-remove: move a batch or one guide into guides/_to_delete/ ──
    // Nothing is hard-deleted; the human empties _to_delete/ themselves (ground rule).
    if (req.method === 'POST' && pathname === '/api/remove') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const slug = (u.searchParams.get('slug') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      try {
        const result = slug ? removeGuide(root, batch, slug, nowIso()) : removeBatch(root, batch, nowIso());
        if (!result) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; }
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      return;
    }
    // ── feedback loop: work-to-do notes (guides/feedback.json) ──
    if (req.method === 'POST' && pathname.startsWith('/api/note')) {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const fp = path.join(root, 'feedback.json');
        let list = []; try { list = JSON.parse(readFileSync(fp, 'utf8')); } catch {}
        const now = nowIso(); let result;
        if (pathname === '/api/note') { const nt = newNote({ ...body, now }); list = addNote(list, nt); result = nt; }
        else if (pathname === '/api/note/update') { list = updateNote(list, body.id, body.patch || {}, now); result = { ok: true }; }
        else if (pathname === '/api/note/delete') { list = removeNote(list, body.id); result = { ok: true }; }
        else { res.writeHead(404); res.end('no'); return; }
        writeFileSync(fp, JSON.stringify(list, null, 2));
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
      } catch (e) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e && e.message || e) })); }
      return;
    }
    // ── studio save-back: the recorded narration ──
    if (req.method === 'POST') {
      const target = path.join(root, pathname);
      if (!target.startsWith(root + path.sep) || path.basename(target) !== 'voice.webm') { res.writeHead(403); res.end('forbidden'); return; }
      try { const body = await readBody(req); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); writeFileSync(path.join(path.dirname(target), 'state.json'), JSON.stringify({ state: 'narrated' }, null, 2)); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    // ── static GET — with HTTP Range support ──
    // Range matters: without 206 responses Chrome's <video> has an EMPTY seekable
    // range for anything not yet buffered, so timeline clicks and step jumps
    // silently snap back to 0 on long recordings. Narration is built on scrubbing.
    let p = pathname;
    if (p === '/') p = '/dashboard.html';
    let file = path.join(root, p);
    // The UI pages are ALWAYS served live from the package's web/ folder — the
    // copyWeb copies in the guides dir are only for portability (other static
    // servers). Serving the startup copies repeatedly shipped stale UI after
    // edits and cost several restart-to-see-the-fix rounds.
    const pageName = path.posix.basename(p);
    if (/^(dashboard|studio|feedback)\.html$/.test(pageName)) {
      const live = path.join(PKG, 'web', pageName);
      if (existsSync(live)) file = live;
    }
    if ((!file.startsWith(root) && !file.startsWith(path.join(PKG, 'web'))) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const size = statSync(file).size;
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
      const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      pipeline(createReadStream(file, { start, end }), res, () => {});   // aborted seeks must not kill the process
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    pipeline(createReadStream(file), res, () => {});
  });
  // SURVIVE, don't die: Range support means every video seek ABORTS the previous
  // request — a closed socket mid-stream raised unhandled 'error' events that
  // killed the whole server (seen in prod: dashboard drop-upload hit
  // ERR_CONNECTION_REFUSED because a seek had crashed the process minutes earlier).
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
  if (!globalThis.__jsGuards) {
    globalThis.__jsGuards = true;   // serve() recurses on EADDRINUSE — register once
    process.on('uncaughtException', (e) => console.error(`✗ server error (survived): ${e.message}`));
    process.on('unhandledRejection', (e) => console.error(`✗ server rejection (survived): ${e && e.message || e}`));
  }
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 12) { console.log(`  :${port} in use — trying :${port + 1}…`); serve(dir, port + 1, host, tries + 1); }
    else { console.error(`✗ serve failed on :${port}: ${e.message}  (free it: lsof -ti tcp:${port} | xargs kill)`); process.exit(1); }
  });
  server.listen(port, host, () => {
    const url = `http://localhost:${port}/dashboard.html`;
    console.log(`▶ dashboard → ${url}  (serving ${root} — drop report folders on the page — Ctrl-C to stop)`);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); } catch {}
  });
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'build') {
  build(path.resolve(args._[1] ?? 'results.json'), path.resolve(args.out ?? 'guides'), args.openapi ? path.resolve(args.openapi) : null);
} else if (cmd === 'ingest') {
  ingest(args);
} else if (cmd === 'serve') {
  serve(args.dir ?? 'guides', args.port ?? 8777, args.host);
} else if (cmd === 'splice') {
  if (!args._[1]) { console.error('usage: journey-studio splice <slug> [--dir ./guides] [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]'); process.exit(1); }
  splice(args._[1], { dir: args.dir, rate: args.rate, band: args.band, fps: args.fps, crf: args.crf, preset: args.preset, addIntro: args.addIntro, intro: args.intro });
} else if (cmd && cmd.endsWith('.json')) {
  const out = build(path.resolve(cmd), path.resolve(args.out ?? 'guides'), args.openapi ? path.resolve(args.openapi) : null);
  serve(out, args.port ?? 8777, args.host);
} else {
  console.log('usage:\n  journey-studio <results.json>                       build one report + open dashboard\n  journey-studio build <results.json> [--out ./guides] [--openapi <spec.json>]\n  journey-studio ingest [--inbox ./inbox] [--openapi <spec.json>]   drop-folder ingest → index\n  journey-studio ingest --from <report-folder> [--batch <id>]\n  journey-studio serve [--dir ./guides] [--port 8777] [--host 127.0.0.1]\n  journey-studio splice <slug> [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]');
  process.exit(cmd ? 1 : 0);
}
