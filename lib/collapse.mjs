// collapse — PURE: fold noisy call/action lists into narratable groups.
// Single source of truth for the grouping the Studio teleprompter shows and the
// narration brief prints. (studio.html carries a mirrored copy for the browser —
// keep them in sync; the tests here are the contract.)

/** Fold consecutive identical (method,path,status) calls into one entry with a count. */
export function collapse(calls) {
  const out = [];
  for (const c of calls || []) {
    const l = out[out.length - 1];
    if (l && l.method === c.method && l.path === c.path && l.status === c.status) l.count++;
    else out.push({ ...c, count: 1 });
  }
  return out;
}

/** Fold consecutive same-shaped groups (polling) into one entry carrying repeats,
 *  total callCount, merged calls, and the poll timestamps (`ats`). A repeated
 *  poll action whose calls interleave with side lookups (status + session + auth)
 *  still folds — the signature is the ACTION (kind + single endpoint or title),
 *  not the exact call mix. */
export function collapsePolls(groups) {
  const out = [];
  for (const g of groups || []) {
    const sig = g.kind + '|' + g.title;   // the ACTION identity — what actually repeats
    const prev = out[out.length - 1];
    if (prev && prev._sig === sig) {
      prev.repeats++;
      prev.callCount += g.calls.reduce((n, c) => n + (c.count || 1), 0);
      prev.ats.push(g.atMs);
      prev.calls = prev.calls.concat(g.calls);
    } else {
      out.push({ ...g, _sig: sig, repeats: 1, callCount: g.calls.reduce((n, c) => n + (c.count || 1), 0), ats: [g.atMs] });
    }
  }
  return out;
}

/** Endpoint frequency across a group's calls, most frequent first:
 *  [{ep: 'GET /api/x', n}] — the dominant endpoint names a polling group. */
export function endpointFreq(calls) {
  const by = new Map();
  for (const c of calls || []) {
    const k = c.method + ' ' + c.path;
    by.set(k, (by.get(k) || 0) + (c.count || 1));
  }
  return [...by.entries()].map(([ep, n]) => ({ ep, n })).sort((a, b) => b.n - a.n);
}

/** One step -> ordered action groups, each with the API calls it caused.
 *  Calls before the first action form an "on load" group; polling folds. */
export function groupStep(s) {
  const A = (s.actions || []).slice().sort((a, b) => a.atMs - b.atMs);
  const C = (s.downstream || []).slice().sort((a, b) => (a.atMs || 0) - (b.atMs || 0));
  const G = [];
  if (!A.length) {
    if (C.length) G.push({ kind: 'load', title: 'API calls', atMs: s.startMs, calls: collapse(C) });
    return collapsePolls(G);
  }
  const pre = C.filter((c) => (c.atMs || 0) < A[0].atMs);
  if (pre.length) G.push({ kind: 'load', title: 'on load', atMs: s.startMs, calls: collapse(pre) });
  A.forEach((a, i) => {
    const n = A[i + 1] ? A[i + 1].atMs : Infinity;
    G.push({ kind: a.kind || 'action', title: a.title, atMs: a.atMs, calls: collapse(C.filter((c) => (c.atMs || 0) >= a.atMs && (c.atMs || 0) < n)) });
  });
  return collapsePolls(G);
}

/** Median gap (ms) between poll timestamps — 0 when fewer than 2. */
export function pollIntervalMs(ats) {
  if (!ats || ats.length < 2) return 0;
  const gaps = [];
  for (let i = 1; i < ats.length; i++) gaps.push(ats[i] - ats[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}
