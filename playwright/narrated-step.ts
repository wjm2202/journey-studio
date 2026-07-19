// @ts-nocheck
// Drop-in TEMPLATE for YOUR Playwright project (which has @playwright/test installed).
// journey-studio itself is zero-dependency and never runs this file, so the
// "Cannot find module @playwright/test" error only appears HERE and is silenced by
// the line above. When you copy this into a real test project you can delete it.

/**
 * narrated-step — OPTIONAL producer helper for rich Journey Studio guides.
 *
 * Drop this file into your Playwright project. Import `test`/`expect` from here
 * in a *.guide.spec.ts, declare the objective as an annotation, and wrap the
 * meaningful moments in `guide.step(...)`. On teardown it attaches a
 * `guide-timeline` to the report; run with the JSON reporter and point
 * Journey Studio at the results.json.
 *
 *   import { test, expect } from './narrated-step';
 *   test('Rotate your API key — guide',
 *     { annotation: [{ type: 'guide', description: JSON.stringify({
 *         objective: 'rotate-api-key', title: 'Rotate your API key', category: 'keys' }) }] },
 *     async ({ page, guide }) => {
 *       await guide.step('Open the key panel', { testId: 'key-panel' }, async () => {
 *         await expect(page.getByTestId('key-panel')).toBeVisible();
 *       });
 *     });
 *
 * Self-contained: only depends on @playwright/test.
 */
import { test as base } from '@playwright/test';

export interface StepMeta { hint?: string; testId?: string; assertions?: string[]; }
export interface GuideApi {
  step<T>(title: string, meta: StepMeta, body: () => Promise<T>): Promise<T>;
}

interface Chapter {
  id: string; index: number; title: string; hint: string | null;
  testId: string | null; startMs: number; endMs: number; assertions: string[];
}

export const test = base.extend<{ guide: GuideApi; _guideT0: number }>({
  // depends on `page`, so it resolves AFTER the video recorder starts — t0 is the video origin
  _guideT0: async ({ page }, use) => { void page; await use(Date.now()); },

  guide: async ({ _guideT0 }, use, testInfo) => {
    const chapters: Chapter[] = [];
    let index = 0;
    const offset = () => Math.max(0, Date.now() - _guideT0); // never before the video

    const api: GuideApi = {
      async step(title, meta, body) {
        index += 1;
        const id = 's' + String(index).padStart(2, '0');
        const startMs = offset();
        const result = await test.step(title, body);
        chapters.push({
          id, index, title,
          hint: meta.hint ?? null, testId: meta.testId ?? null,
          startMs, endMs: offset(), assertions: meta.assertions ?? [],
        });
        return result;
      },
    };

    await use(api);
    await testInfo.attach('guide-timeline', {
      body: JSON.stringify({ t0: _guideT0, chapters }),
      contentType: 'application/json',
    });
  },
});

export { expect } from '@playwright/test';
