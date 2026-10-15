// Built-in transition presets, picked through Pageflow.go(), a link attribute, and reduced motion.
const { test, expect } = require('@playwright/test');
const { open, go, click, expectSameDocument, framesOf, HOOK_ORDER } = require('./helpers');

test.describe('presets', () => {
  test('fade: old page fades out, new page fades in', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await go(page, '/about', { transition: 'fade' });

    const home = framesOf(samples, 'home');
    const about = framesOf(samples, 'about');
    expect(home.some((f) => f.c.opacity > 0.05 && f.c.opacity < 0.95)).toBe(true);
    expect(about.some((f) => f.c.opacity > 0.05 && f.c.opacity < 0.95 && f.c.visibility === 'visible')).toBe(true);
    // Never two containers at once in a sequential preset.
    expect(samples.every((s) => s.containers.length === 1)).toBe(true);
    // Ends fully visible with no inline leftovers.
    expect(await page.evaluate(() => document.querySelector('[data-pageflow="container"]').style.opacity)).toBe('');

    await expectSameDocument(page);
    expect(await page.evaluate(() => location.pathname)).toBe('/about');
    expect(errors).toEqual([]);
  });

  test('slide-up: old page moves up, new page rises in', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await go(page, '/about', { transition: 'slide-up' });

    expect(framesOf(samples, 'home').some((f) => f.c.ty < -2)).toBe(true);
    expect(framesOf(samples, 'about').some((f) => f.c.ty > 2 && f.c.visibility === 'visible')).toBe(true);
    expect(await page.evaluate(() => document.querySelector('[data-pageflow="container"]').style.transform)).toBe('');
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('slide-left: forward slides left', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await go(page, '/contact', { transition: 'slide-left' });

    expect(framesOf(samples, 'home').some((f) => f.c.tx < -2)).toBe(true);
    expect(framesOf(samples, 'contact').some((f) => f.c.tx > 2 && f.c.visibility === 'visible')).toBe(true);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('overlay: a panel covers the page during the swap and is removed after', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await go(page, '/about', { transition: 'overlay' });

    expect(samples.some((s) => s.overlay)).toBe(true);
    // The swap happens under the overlay.
    const firstAbout = samples.findIndex((s) => s.containers.some((c) => c.ns === 'about'));
    expect(samples[firstAbout].overlay).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector('[data-pageflow-generated-overlay]'))).toBe(false);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('none: swaps without animating', async ({ page }) => {
    const { errors } = await open(page, '/');
    await page.evaluate(() => Pageflow.prefetch('/about'));
    const { samples, duration } = await go(page, '/about', { transition: 'none' });

    expect(samples.every((s) => s.containers.every((c) => c.opacity === 1 && c.tx === 0 && c.ty === 0))).toBe(true);
    expect(duration).toBeLessThan(600);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('link attribute data-pageflow-transition="fade" overrides the page default (ix3)', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await click(page, '#nav-contact-fade');

    expect(framesOf(samples, 'home').some((f) => f.c.opacity > 0.05 && f.c.opacity < 0.95)).toBe(true);
    // The IX3 panel never moved: this was a fade, not the page's ix3 transition.
    expect(samples.every((s) => s.panelTop > 0)).toBe(true);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('reduced motion: presets swap instantly', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const { errors } = await open(page, '/');
    await page.evaluate(() => Pageflow.prefetch('/about'));
    const { samples } = await go(page, '/about', { transition: 'fade' });

    expect(samples.every((s) => s.containers.every((c) => c.opacity === 0 || c.opacity === 1))).toBe(true);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('hooks fire once each, in order', async ({ page }) => {
    await open(page, '/');
    await go(page, '/about', { transition: 'fade' });
    expect(await page.evaluate(() => window.__pfLog)).toEqual(HOOK_ORDER);
  });
});
