// Site-wide defaults from a config object, and how attributes override them.
// The test site puts data-pageflow-transition="ix3" on every container; tests that need the
// config to be the only setting strip that attribute from the HTML as it is served.
const { test, expect } = require('@playwright/test');
const { open, click, expectSameDocument, framesOf, timeHooks } = require('./helpers');

const stripTransition = (html) => html.replace(/ data-pageflow-transition="ix3"/g, '');

test.describe('site-wide config', () => {
  test('window.pageflowConfig with animation/duration sets the default for the whole site', async ({ page }) => {
    const { errors, warnings } = await open(page, '/', {
      configName: 'pageflowConfig',
      config: { animation: 'slide-up', duration: 800 },
      rewrite: stripTransition
    });
    expect(await page.evaluate(() => [Pageflow.options.transition, Pageflow.options.duration])).toEqual(['slide-up', 800]);

    const times = await timeHooks(page);
    const { samples } = await click(page, '#nav-about');
    expect(framesOf(samples, 'home').some((f) => f.c.ty < -2)).toBe(true);
    expect(framesOf(samples, 'about').some((f) => f.c.ty > 2)).toBe(true);
    const t = await times();
    expect(t.leave).toBeGreaterThan(750);
    expect(t.leave).toBeLessThan(1100);
    expect(t.enter).toBeGreaterThan(750);
    expect(t.enter).toBeLessThan(1100);

    await expectSameDocument(page);
    expect(warnings.filter((w) => w.includes('[Pageflow]'))).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('window.PageflowConfig still works, and attributes override it', async ({ page }) => {
    const { errors } = await open(page, '/', { config: { transition: 'slide-up', duration: 300 } });

    // The containers' data-pageflow-transition="ix3" beats the config: the IX3 panel runs.
    const ix3 = await click(page, '#nav-about');
    expect(ix3.samples.some((s) => s.panelTop === 0)).toBe(true);

    // The link's data-pageflow-transition="fade" beats both, and the config duration still applies.
    const times = await timeHooks(page);
    const fade = await click(page, '#nav-contact-fade');
    expect(framesOf(fade.samples, 'about').some((f) => f.c.opacity > 0.05 && f.c.opacity < 0.95)).toBe(true);
    const t = await times();
    expect(t.leave).toBeGreaterThan(250);
    expect(t.leave).toBeLessThan(600);
    expect(errors).toEqual([]);
  });

  test('data-pageflow-duration on the incoming page container applies when arriving', async ({ page }) => {
    await open(page, '/', {
      config: { transition: 'fade' },
      rewrite: (html) => stripTransition(html).replace('data-pageflow-namespace="about"', 'data-pageflow-namespace="about" data-pageflow-duration="1000"')
    });
    const times = await timeHooks(page);
    await click(page, '#nav-about');
    const t = await times();
    expect(t.leave).toBeGreaterThan(950);
    expect(t.enter).toBeGreaterThan(950);
    expect(t.enter).toBeLessThan(1400);
  });

  test('data-pageflow-duration on <body> applies site-wide, under the config', async ({ page }) => {
    await open(page, '/', {
      config: { transition: 'fade', duration: 200 },
      rewrite: (html) => stripTransition(html).replace(/<body([^>]*)>/, '<body$1 data-pageflow-duration="900">')
    });
    const times = await timeHooks(page);
    await click(page, '#nav-about');
    const t = await times();
    expect(t.leave).toBeGreaterThan(850);
    expect(t.leave).toBeLessThan(1300);
  });

  test('unknown option names warn instead of failing silently', async ({ page }) => {
    const { warnings } = await open(page, '/', { configName: 'pageflowConfig', config: { animaton: 'fade' } });
    expect(warnings.some((w) => w.includes('Unknown option "animaton"'))).toBe(true);
  });
});
