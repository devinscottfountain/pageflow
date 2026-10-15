// Custom code: site-wide code, page-level code, embeds, page head styles, JS transitions and hooks.
// The test site has:
//   site footer  - a const declaration, a Pageflow.page() handler, a hook log, a 'zoom' GSAP
//                  transition, and a Contact -> Home rule-based transition
//   About        - page footer code (const, DOMContentLoaded, setInterval) and a page head <style>
//   Contact      - an HTML embed with a script, and a Webflow form
const { test, expect } = require('@playwright/test');
const { open, go, click, expectSameDocument } = require('./helpers');

test.describe('custom code', () => {
  test('site-wide code runs once; Pageflow.page() runs on every page', async ({ page }) => {
    const { errors } = await open(page, '/');
    await click(page, '#nav-about');
    await click(page, '#nav-contact');
    await go(page, '/', { transition: 'none' });

    const r = await page.evaluate(() => ({
      siteRuns: window.__siteRuns,
      handlerRuns: window.__pageHandlerRuns,
      ns: document.documentElement.getAttribute('data-current-ns')
    }));
    expect(r).toEqual({ siteRuns: 1, handlerRuns: 4, ns: 'home' });
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('page-level code runs on every visit, with const and DOMContentLoaded', async ({ page }) => {
    const { errors } = await open(page, '/');
    await click(page, '#nav-about');
    await expect(page.locator('#page-status')).toHaveText('about page code ran 1x');
    await click(page, '#nav-home');
    await click(page, '#nav-about');
    await expect(page.locator('#page-status')).toHaveText('about page code ran 2x');
    // A const redeclared on the second run would have thrown.
    expect(errors).toEqual([]);
  });

  test('intervals started by page code stop when leaving the page', async ({ page }) => {
    await open(page, '/about');
    await expect.poll(() => page.evaluate(() => window.__aboutTicks || 0)).toBeGreaterThan(2);
    await click(page, '#nav-contact');
    const a = await page.evaluate(() => window.__aboutTicks);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__aboutTicks)).toBe(a);
  });

  test('when arriving from another page, About page code still runs once per visit', async ({ page }) => {
    // First load is About itself (code runs natively), then it is re-run by Pageflow.
    const { errors } = await open(page, '/about');
    await expect(page.locator('#page-status')).toHaveText('about page code ran 1x');
    await click(page, '#nav-contact');
    await click(page, '#nav-about');
    await expect(page.locator('#page-status')).toHaveText('about page code ran 2x');
    expect(errors).toEqual([]);
  });

  test('embed scripts inside the container run on every visit', async ({ page }) => {
    const { errors } = await open(page, '/');
    await click(page, '#nav-contact');
    await expect(page.locator('#embed-out')).toHaveText('embed ran 1x');
    await click(page, '#nav-about');
    await click(page, '#nav-contact');
    await expect(page.locator('#embed-out')).toHaveText('embed ran 2x');
    expect(errors).toEqual([]);
  });

  test('page head <style> is added on arrival and removed on leave', async ({ page }) => {
    await open(page, '/');
    const color = () => page.evaluate(() => getComputedStyle(document.querySelector('.pf-title')).color);
    expect(await color()).not.toBe('rgb(0, 102, 204)');
    await click(page, '#nav-about');
    expect(await color()).toBe('rgb(0, 102, 204)');
    await click(page, '#nav-contact');
    expect(await color()).not.toBe('rgb(0, 102, 204)');
  });

  test('head and Webflow page attributes follow the page', async ({ page }) => {
    await open(page, '/');
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-wf-page'));
    await click(page, '#nav-contact');
    const r = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]').content,
      wfPage: document.documentElement.getAttribute('data-wf-page')
    }));
    expect(r.title).toBe('Contact · Pageflow test');
    expect(r.description).toBe('Contact page description');
    expect(r.wfPage).not.toBe(before);
  });

  test('Webflow components re-initialise: the form module is live after a transition', async ({ page }) => {
    const { errors } = await open(page, '/');
    await click(page, '#nav-contact');
    const r = await page.evaluate(() => ({
      forms: !!Webflow.require('forms'),
      form: !!document.querySelector('.w-form form'),
      doneHidden: getComputedStyle(document.querySelector('.w-form-done')).display === 'none'
    }));
    expect(r).toEqual({ forms: true, form: true, doneHidden: true });
    expect(errors).toEqual([]);
  });

  test('a named JS transition registered with Pageflow.transition() runs', async ({ page }) => {
    const { errors } = await open(page, '/');
    const { samples } = await go(page, '/about', { transition: 'zoom' });
    expect(await page.evaluate(() => window.__zoomCalls)).toEqual(['leave', 'enter']);
    expect(samples.some((s) => s.containers.some((c) => c.ns === 'home' && c.scale < 0.99))).toBe(true);
    expect(samples.some((s) => s.containers.some((c) => c.ns === 'about' && c.scale > 1.01))).toBe(true);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('a from/to rule wins over attributes (Contact -> Home)', async ({ page }) => {
    const { errors } = await open(page, '/contact');
    const { samples } = await click(page, '#nav-home');
    expect(await page.evaluate(() => window.__ruleCalls)).toEqual(['leave', 'enter']);
    // The page default (ix3) did not run.
    expect(samples.every((s) => s.panelTop > 0)).toBe(true);
    expect(samples.some((s) => s.containers.some((c) => c.ns === 'contact' && c.tx < -2))).toBe(true);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });

  test('data-pageflow-prevent links load the page normally', async ({ page }) => {
    await open(page, '/');
    await page.evaluate(() => {
      const a = document.createElement('a');
      a.href = '/about'; a.id = 'plain'; a.textContent = 'plain'; a.setAttribute('data-pageflow-prevent', '');
      document.querySelector('.pf-nav').appendChild(a);
    });
    await Promise.all([page.waitForURL('**/about'), page.click('#plain')]);
    await page.waitForFunction(() => window.Pageflow && window.Pageflow.current);
    expect(await page.evaluate(() => window.__marker)).toBeUndefined();
  });

  test('a click during a transition is queued and runs next', async ({ page }) => {
    const { errors } = await open(page, '/');
    await page.evaluate(() => {
      window.__arrived = [];
      Pageflow.on('after', () => window.__arrived.push(Pageflow.current.namespace));
      Pageflow.go('/about', { transition: 'fade' });
      setTimeout(() => Pageflow.go('/contact', { transition: 'fade' }), 100);
    });
    await expect.poll(() => page.evaluate(() => window.__arrived), { timeout: 10000 }).toEqual(['about', 'contact']);
    await expectSameDocument(page);
    expect(errors).toEqual([]);
  });
});
