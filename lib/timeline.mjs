// Pure timeline helpers — no deps, no fs. Shared by build + (later) the studio.
import { createHash } from 'node:crypto';

export const slugify = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'guide';

/** True if the last chapter ends within the video duration (+ tolerance). */
export function isAligned(steps, videoDurationMs, toleranceMs = 750) {
  if (!steps.length) return true;
  return steps[steps.length - 1].endMs <= videoDurationMs + toleranceMs;
}

/** Stable identity of a documented flow: hash of ordered {title,testId,assertions}.
 *  testId accepts string | null | undefined (JSON null vs TS undefined) — both
 *  canonicalise to null, so an absent testid hashes identically. */
export function fingerprint(steps) {
  const canon = steps.map((s) => ({ title: s.title, testId: s.testId ?? null, assertions: (s.assertions ?? []).slice() }));
  return 'sha256:' + createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
