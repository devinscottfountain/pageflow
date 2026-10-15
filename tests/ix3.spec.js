// Transitions designed in Webflow's Interactions panel (IX3), and IX3 re-initialisation.
// The test site has: a .pf-panel moved by custom events "pageflow:leave" / "pageflow:enter",
// a page-load reveal on .pf-title, and data-pageflow-transition="ix3" on every container.
const { test, expect } = require('@playwright/test');
const { open, click, go, transition, expectSameDocument, framesOf } = require('./helpers');

const VIEWPORT_H = 800;

test.describe('IX3', () => {
  test('the panel covers the page before the swap, stays during it, and leaves after', async ({ page }) => {
    const { errors } = await open(page, '/');
    expect(await page.evaluate(() => Math.round(document.querySelector('.pf-panel').getBoundingClientRect().top))).toBe(VIEWPORT_H);

    const { samples } = await click(page, '#nav-about');

    // Leave: the panel reaches the top while the old page is still there.
    const home = framesOf(samples, 'home');
    expect(home[home.length - 1].panelTop).toBe(0);
    // Swap: every frame of the new page before the panel starts moving away has the panel at 0.
    const about = framesOf(samples, 'about');
    const firstMove = about.findIndex((f) => f.panelTop !== 0);
    expect(firstMove).toBeGreaterThan(0);
    expect(about.slice(0, firstMove).every((f) => f.panelTop === 0)).toBe(true);
    // Enter: the panel ends off-screen above, never sweeping back down over the new page.
    expect(about.slice(firstMove).every((f) => f.panelTop < 0)).toBe(true);
    expect(about[about.length - 1].panelTop).toBeLessThanOrEqual(-VIEWPORT_H);

    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('Pageflow waits for the IX3 timelines, not longer', async ({ page }) => {
    await open(page, '/');
    await page.evaluate(() => {
      window.__times = {};
      ['leave', 'afterLeave', 'enter', 'afterEnter'].forEach((h) => Pageflow.on(h, () => { window.__times[h] = performance.now(); }));
    });
    await click(page, '#nav-about');
    const t = await page.evaluate(() => window.__times);
    // Leave timeline is 0.6s; enter is 0.1s delay + 0.6s. Allow for frame timing and fetch.
    expect(t.afterLeave - t.leave).toBeGreaterThan(550);
    expect(t.afterLeave - t.leave).toBeLessThan(1500);
    expect(t.afterEnter - t.enter).toBeGreaterThan(650);
    expect(t.afterEnter - t.enter).toBeLessThan(1100);
  });

  test('IX3 is re-registered on the new page and page-load interactions play again', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await click(page, '#nav-about');

    // The new page's title is revealed by the IX3 load interaction (it starts transparent).
    const about = framesOf(samples, 'about');
    expect(about.some((f) => f.titleOpacity !== null && f.titleOpacity < 0.5)).toBe(true);
    await expect.poll(() => page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.pf-title')).opacity))).toBe(1);

    const ix3 = await page.evaluate(() => {
      const inst = Webflow.require('ix3').getInstance();
      return { count: inst.interactions.size, ids: [...inst.interactions.keys()] };
    });
    expect(ix3.count).toBe(3);
    expect(errors).toEqual([]);
  });

  test('repeated IX3 transitions keep working (no duplicated engines or listeners)', async ({ page }) => {
    const { errors } = await open(page, '/');
    for (const id of ['#nav-about', '#nav-contact', '#nav-about', '#nav-home']) {
      const { samples } = await click(page, id);
      const covered = samples.filter((s) => s.panelTop === 0).length;
      expect(covered, `panel covered the page during ${id}`).toBeGreaterThan(0);
      expect(samples[samples.length - 1].panelTop).toBeLessThanOrEqual(-VIEWPORT_H);
    }
    // One emit per phase: count how many times the leave timeline ran during one more transition.
    const plays = await page.evaluate(async () => {
      const m = Webflow.require('ix3');
      let n = 0;
      const orig = m.getInstance().emit;
      m.getInstance().emit = function (name) { if (name === 'pageflow:leave') n++; return orig.apply(this, arguments); };
      const done = new Promise((r) => Pageflow.once('afterLeave', r));
      document.querySelector('#nav-about').click();
      await done;
      return n;
    });
    expect(plays).toBe(1);
    await page.evaluate(() => new Promise((r) => Pageflow.once('after', r)));
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('back and forward use the page transition and restore the right page', async ({ page }) => {
    const { errors } = await open(page, '/');
    await click(page, '#nav-about');
    await click(page, '#nav-contact');

    const back = await transition(page, () => history.back());
    expect(await page.evaluate(() => [location.pathname, Pageflow.current.namespace])).toEqual(['/about', 'about']);
    expect(back.samples.some((s) => s.panelTop === 0)).toBe(true);

    await go(page, '/', { transition: 'none' });
    expect(await page.evaluate(() => Pageflow.current.namespace)).toBe('home');
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
});
