const path = require('path');
const { expect } = require('@playwright/test');

const LOCAL_BUILD = path.join(__dirname, '..', 'dist', 'pageflow.min.js');
const SITE = process.env.PAGEFLOW_SITE || 'https://devins-superb-site-3f731d.webflow.io';

// Opens a page of the test site with Pageflow running and test instrumentation installed.
//   config:  object assigned to window[configName] before any page script runs
//   rewrite: (html) => html, applied to every page of the site (first load and Pageflow's fetches)
async function open(page, pathname = '/', { config, configName = 'PageflowConfig', rewrite } = {}) {
  const errors = [];
  const warnings = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text()); });

  if (!process.env.PAGEFLOW_CDN) {
    await page.route(/\/pageflow(\.min)?\.js(\?|$)/, (route) =>
      route.fulfill({ path: LOCAL_BUILD, contentType: 'application/javascript' })
    );
  }
  if (config) {
    await page.addInitScript(([name, value]) => { window[name] = value; }, [configName, config]);
  }
  if (rewrite) {
    const origin = new URL(SITE).origin;
    await page.route((url) => url.origin === origin, async (route) => {
      const response = await route.fetch();
      const type = response.headers()['content-type'] || '';
      if (!type.includes('text/html')) return route.fulfill({ response });
      route.fulfill({ response, body: rewrite(await response.text()) });
    });
  }

  await page.goto(pathname);
  await page.waitForFunction(() => window.Pageflow && window.Pageflow.current);
  // Survives transitions, disappears on a full page load.
  await page.evaluate(() => { window.__marker = 'same-document'; });
  return { errors, warnings };
}

// Starts recording, on every animation frame, what the page looks like during a transition.
async function startSampling(page) {
  await page.evaluate(() => {
    const t0 = performance.now();
    window.__samples = [];
    window.__sampling = true;
    const tick = () => {
      if (!window.__sampling) return;
      const containers = [...document.querySelectorAll('[data-pageflow="container"]')].map((c) => {
        const cs = getComputedStyle(c);
        const m = new DOMMatrix(cs.transform === 'none' ? undefined : cs.transform);
        return {
          ns: c.getAttribute('data-pageflow-namespace'),
          opacity: parseFloat(cs.opacity),
          tx: Math.round(m.m41),
          ty: Math.round(m.m42),
          scale: Math.round(m.a * 1000) / 1000,
          visibility: cs.visibility
        };
      });
      const panel = document.querySelector('.pf-panel');
      const title = document.querySelector('[data-pageflow="container"] .pf-title');
      window.__samples.push({
        t: Math.round(performance.now() - t0),
        containers,
        overlay: !!document.querySelector('[data-pageflow-generated-overlay]'),
        panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
        titleOpacity: title ? parseFloat(getComputedStyle(title).opacity) : null
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopSampling(page) {
  return page.evaluate(() => { window.__sampling = false; return window.__samples; });
}

// Runs `trigger` (a function evaluated in the page) and waits until Pageflow's "after" hook fires.
// Returns the frame samples recorded during the transition and the time from trigger to "after".
async function transition(page, trigger, arg) {
  await page.evaluate(() => {
    window.__pfLog = window.__pfLog || [];
    window.__pfLog.length = 0;
    window.__doneAt = null;
    window.__done = new Promise((resolve) => {
      Pageflow.once('after', () => { window.__doneAt = performance.now(); resolve(); });
    });
    window.__startedAt = performance.now();
  });
  await startSampling(page);
  await page.evaluate(trigger, arg);
  await page.evaluate(() => window.__done);
  const samples = await stopSampling(page);
  const duration = await page.evaluate(() => Math.round(window.__doneAt - window.__startedAt));
  return { samples, duration };
}

function go(page, url, options) {
  return transition(page, ([u, o]) => { Pageflow.go(u, o); }, [url, options || {}]);
}

function click(page, selector) {
  return transition(page, (s) => { document.querySelector(s).click(); }, selector);
}

async function expectSameDocument(page) {
  expect(await page.evaluate(() => window.__marker)).toBe('same-document');
}

// Samples where only one container (the given namespace) is on the page.
function framesOf(samples, ns) {
  return samples.filter((s) => s.containers.length === 1 && s.containers[0].ns === ns).map((s) => ({ ...s, c: s.containers[0] }));
}

const HOOK_ORDER = ['before', 'beforeLeave', 'leave', 'afterLeave', 'beforeEnter', 'webflowReady', 'enter', 'afterEnter', 'after'];

// Records when each hook fires, to measure how long the leave and enter phases took.
async function timeHooks(page) {
  await page.evaluate(() => {
    window.__times = {};
    ['leave', 'afterLeave', 'enter', 'afterEnter'].forEach((h) => Pageflow.on(h, () => { window.__times[h] = performance.now(); }));
  });
  return async () => {
    const t = await page.evaluate(() => window.__times);
    return { leave: t.afterLeave - t.leave, enter: t.afterEnter - t.enter };
  };
}

module.exports = { SITE, open, transition, go, click, expectSameDocument, framesOf, timeHooks, HOOK_ORDER };
