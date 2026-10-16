# Pageflow

Page transitions for Webflow. Pages change without a full reload, and everything Webflow normally sets up on page load keeps working afterwards:

- **IX3** (Interactions with GSAP) and **IX2** interactions re-run on the new page
- **Webflow components** (navbar, slider, tabs, forms, lightbox, dropdowns) re-initialise
- **Custom code**, site-wide and per page, behaves as if the page had loaded normally

No dependencies. ~8 KB gzipped.

## Install

### 1. Add the script (Project settings → Custom code → Head code)

```html
<script src="https://cdn.jsdelivr.net/gh/devinscottfountain/pageflow@1.0.2/dist/pageflow.min.js"></script>
```

### 2. Mark the part of the page that changes

In the Designer, select the element that wraps each page's content (usually a `main` or a `page-wrapper` div, *not* the nav or footer) and add a custom attribute:

| Name | Value |
|---|---|
| `data-pageflow` | `container` |

Do this on every page (or put it in a component used on every page). Pages without a container load normally.

That's it: links between pages now fade. Publish and click around.

### 3. Optional: set site-wide defaults

Add this to **Project settings → Custom code** (head or footer) to pick the transition and speed for the whole site in one place, instead of adding attributes to every page:

```html
<script>
  window.PageflowConfig = {
    transition: 'slide-up',
    duration: 800
  };
</script>
```

This is the bottom of the inheritance order: any `data-pageflow-transition` or `data-pageflow-duration` attribute on a link, page or the Body overrides it. Every [option](#options) can go here. `window.pageflowConfig` works too, as do `animation` and `speed` in place of `transition` and `duration`. A misspelled option name logs a warning in the console.

## Choosing a transition

Add `data-pageflow-transition` with one of these values:

| Value | What it does |
|---|---|
| `fade` | Fades the old page out and the new one in (default) |
| `slide-up` | Old page fades up and out, new page rises in |
| `slide-left` | Horizontal slide; reverses direction when going back |
| `overlay` | A full-screen panel wipes up, the page swaps underneath, then it wipes away |
| `ix3` | Plays animations you design in Webflow's Interactions panel (see below) |
| `none` | Swaps instantly |

Where you put the attribute decides when it applies, most specific first:

1. **On a link**: only clicks on that link
2. **On the incoming page's container**: every visit *to* that page
3. **On the outgoing page's container**: every visit *from* that page
4. **On the Body element**: that page's default
5. **`window.PageflowConfig`**: the whole site's default ([site-wide defaults](#3-optional-set-site-wide-defaults))

`data-pageflow-duration` follows the same order.

Other attributes:

| Attribute | Where | Effect |
|---|---|---|
| `data-pageflow-duration="600"` | link, container, Body or `<html>` | Preset length in ms (IX3: how long to wait instead of detecting it) |
| `data-pageflow-namespace="work"` | container | Names the page for rules and `Pageflow.page()`; defaults to the Webflow page ID |
| `data-pageflow-prevent` | link | That link loads the page normally |
| `data-pageflow-prevent="all"` | any element | Every link inside it loads normally |
| `data-pageflow-no-prefetch` | link | Don't preload on hover |
| `data-pageflow="overlay"` | any element | Use your own styled element for the `overlay` transition instead of the plain colour panel |

Links that open in a new tab, downloads, `mailto:`/`tel:` links, other domains, same-page `#anchors`, lightboxes, and Webflow e-commerce checkout and membership pages always load normally.

## Transitions designed in IX3

1. In the Interactions panel, create an interaction with the **Custom event** trigger named `pageflow:leave` and animate the page out (for example, slide a full-screen `.transition-panel` up to cover the page).
2. Create a second interaction triggered by the custom event `pageflow:enter` that animates the page in (slide the panel away).
3. Set `data-pageflow-transition="ix3"` on the Body (or a container or link).

Pageflow fires `pageflow:leave`, waits for the animation to finish, swaps the page, re-starts IX3, then fires `pageflow:enter`. It detects when the GSAP timelines finish; if your timeline does something unusual, set `data-pageflow-duration` (ms) to tell it how long to wait.

Keep the transition element **outside** the container (e.g. next to the nav) so it persists across pages. Pageflow keeps elements outside the container exactly where IX3 left them while it re-starts Webflow, so the panel stays over the page during the swap.

Tips for the panel:

- Hide it with the interaction itself: make the leave animation a **From–To** (e.g. Move Y from 100% to 0%). IX3 holds the "from" value while it waits, which keeps the panel off-screen between transitions.
- If you also hide it with a CSS transform on its class (to avoid a flash before IX3 starts), GSAP reads that transform as a fixed pixel offset. Add **Move Y px 0 → 0** to the same leave action so the panel lands at exactly 0.
- Make the enter animation a **To** (e.g. Move Y to -100%), so it starts from wherever the panel is (covering the page).

Tested end to end on a published Webflow site with IX3: a panel covering the page on leave, the page swap under it, page-load interactions re-running on the new page, and the panel sliding away on enter.

## Transitions in code (GSAP or anything else)

Add this to the site-wide **Footer code**, after the script tag:

```html
<script>
Pageflow.init({
  transitions: [{
    name: 'work-to-project',
    from: { namespace: 'work' },
    to: { namespace: 'project' },
    leave: (data) => gsap.to(data.current.container, { opacity: 0, y: -40, duration: 0.5 }),
    enter: (data) => gsap.from(data.next.container, { opacity: 0, y: 40, duration: 0.5 })
  }]
});
</script>
```

- `leave` and `enter` can return a Promise (GSAP tweens work as-is); Pageflow waits for it.
- Rules: `from` / `to` take `namespace` (string or array), `path` (string or RegExp), or `custom: (page) => boolean`. The first matching transition wins; if none match, the attribute presets apply.
- `sync: true` runs `leave` and `enter` at the same time with both containers on the page (you position them).
- `once(data)` runs on the first page load.

Register a named transition so it can be picked with an attribute:

```js
Pageflow.transition('zoom', { leave: (d) => ..., enter: (d) => ... });
// <a data-pageflow-transition="zoom">
```

## Lifecycle hooks

```js
Pageflow.on('beforeLeave', (data) => { /* menu closing, etc. */ });
Pageflow.on('afterEnter', (data) => { /* analytics page view */ });
```

Order: `before` → `beforeLeave` → `leave` → `afterLeave` → `beforeEnter` → `webflowReady` → `enter` → `afterEnter` → `after`. Also `once` (first load) and `error`.

Every hook gets `data` with:

- `data.current` / `data.next`: `{ url, namespace, container }`
- `data.trigger`: the clicked link, `'popstate'` (back/forward) or `'api'`
- `data.direction`: `'forward'` or `'back'`

The same events are dispatched on `document` as `pageflow:<hook>` (`document.addEventListener('pageflow:afterEnter', …)`).

## Custom code

### How Pageflow treats your code

| Code | Behaviour |
|---|---|
| **Site-wide** head/footer code | Runs once, on the first page load, and stays running. It is *not* run again on page changes. |
| **Page-level** head/footer code | Runs every time you arrive on that page, like a normal load. |
| **Embeds inside the container** | Run every time the page is shown. |
| **Libraries** (`<script src>`) | Loaded once, the first time a page needs them. |

Pageflow decides what is page-level by comparing the incoming page's scripts with the outgoing page's: a script both pages share is treated as site-wide.

When page code re-runs:

- Top-level `const` / `let` / `class` don't clash with the previous visit (each run is block-scoped).
- `DOMContentLoaded`, `load`, `window.onload` and jQuery `$(fn)` handlers fire immediately.
- `window`/`document` event listeners and `setInterval`s it adds are removed automatically when you leave the page, so they don't pile up.

### Running site-wide code on every page

Site-wide code only runs once, so anything that sets up page content (sliders, counters, form logic) should go in `Pageflow.page()`:

```js
Pageflow.page((page) => {
  // runs on the first load and after every transition
  const swiper = new Swiper(page.container.querySelector('.swiper'));
  return () => swiper.destroy(); // optional cleanup when leaving
});

Pageflow.page('work', (page) => {
  // only on pages with data-pageflow-namespace="work"
});
```

In page-level code you can register cleanup with `Pageflow.onLeave(fn)`.

### Script attributes

| Attribute on `<script>` | Effect |
|---|---|
| `data-pageflow-rerun` | Run this script on every page change, even if it is site-wide |
| `data-pageflow-skip` | Never run this script on page changes |
| `data-pageflow-no-scope` | Don't block-scope the code (if it must declare true globals with `let`/`const`) |

## Options

Set them site-wide with `window.PageflowConfig = {...}` in head or footer code (see [site-wide defaults](#3-optional-set-site-wide-defaults)), or pass them to `Pageflow.init({...})` in footer code. `init()` options win over `PageflowConfig`.

| Option | Default | |
|---|---|---|
| `transition` | `'fade'` | Default preset |
| `duration` | `400` | Preset length (ms). IX3 transitions detect their own length unless an attribute sets it |
| `easing` | `'cubic-bezier(0.65, 0, 0.35, 1)'` | Preset easing |
| `overlayColor` | `'#000'` | Colour of the built-in overlay |
| `prefetch` | `true` | Preload pages on hover, touch and keyboard focus |
| `timeout` | `10000` | Give up and load normally after this many ms |
| `scrollToTop` | `true` | Scroll to top on new pages (back/forward restores position) |
| `reinitWebflow` | `true` | Re-start Webflow, IX2 and IX3 after each swap |
| `rerunScripts` | `true` | Run page-level custom code after each swap |
| `autoCleanup` | `true` | Remove listeners and intervals page code added |
| `ix3LeaveEvent` / `ix3EnterEvent` | `'pageflow:leave'` / `'pageflow:enter'` | Custom event names for IX3 transitions |
| `exclude` | `null` | `RegExp` (tested on the path) or `(url, link) => boolean` to skip links |
| `focus` / `announce` | `true` | Move focus to the new page's `h1` and announce its title to screen readers |
| `debug` | `false` | Log what Pageflow does |

Pageflow starts by itself when the page is ready. Add `data-pageflow-manual` to `<html>` (via code) to start it yourself with `Pageflow.init()`.

## API

```js
Pageflow.go('/about')            // navigate with a transition
Pageflow.go('/about', { transition: 'none' })
Pageflow.prefetch('/pricing')
Pageflow.current                 // { url, namespace, container }
Pageflow.running                 // true during a transition
Pageflow.reinitWebflow()         // re-start Webflow/IX after you change the DOM yourself
Pageflow.destroy()               // stop handling links
```

## Things to know

- **What changes:** only the container. The nav, footer and anything else outside it stay as they are, so keep elements that should persist (nav, transition overlay, music player) outside the container.
- **`<head>` updates:** title, description, Open Graph/Twitter tags, canonical, JSON-LD, `<html lang>`, the Webflow page attributes, and the body's classes and attributes. Page-level `<style>` tags in the head are added on arrival; mark one `data-pageflow-page-style` and it will also be removed when you leave.
- **IX3 page-load interactions** play again on every page, the same as a normal load. Scroll-triggered animations are refreshed.
- **Webflow Editor:** Pageflow switches itself off there.
- **Reduced motion:** presets become instant for visitors who ask for reduced motion.
- **If anything fails** (network error, missing container, a script throws during the swap), Pageflow falls back to a normal page load.

## Tests

End-to-end tests run in headless Chromium (Playwright) against a published Webflow test site that uses IX3, a Webflow form, an HTML embed, and site- and page-level custom code.

```bash
npm install
npx playwright install chromium
npm test            # builds dist/, then tests it on the live Webflow site
npm run test:cdn    # tests the release published on jsDelivr instead
```

`npm test` serves the site's Pageflow `<script>` from your local `dist/` build, so it checks your working copy against real Webflow, IX3 and GSAP. Point it at another site with `PAGEFLOW_SITE=https://your-site.webflow.io`. That site needs the same structure as the test site (`.pf-nav` links `#nav-home`, `#nav-about`, `#nav-contact`, `#nav-contact-fade`; `.pf-panel`; `.pf-title`) and its custom code.

| Suite | Covers |
|---|---|
| `tests/presets.spec.js` | `fade`, `slide-up`, `slide-left`, `overlay`, `none`, link attributes, reduced motion, hook order |
| `tests/ix3.spec.js` | Panel covers the page through the swap; waiting for IX3 timelines; IX3 re-registration and page-load replays; repeated transitions; back/forward |
| `tests/config.spec.js` | `PageflowConfig` / `pageflowConfig` defaults, `animation`/`speed` names, attributes overriding config, duration on the incoming container and Body, unknown-option warnings |
| `tests/custom-code.spec.js` | Site code runs once; `Pageflow.page()`; page code re-runs with `const` and `DOMContentLoaded`; interval cleanup; embeds; page head styles; head/`data-wf-page` sync; Webflow forms; `Pageflow.transition()`; from/to rules; `data-pageflow-prevent`; queued clicks |

Transitions are checked frame by frame: every animation frame records each container's opacity and transform, the IX3 panel's position, and the title's opacity.

## How it works

On each page change Pageflow fetches the next page, runs the leave animation, swaps the container, and updates the head. It then calls `Webflow.destroy()`, clears `window.Webflow`, and runs the incoming page's own `webflow.*.js` bundle again. That bundle re-defines Webflow's modules, starts IX2, and re-registers the page's IX3 interactions against the new DOM. Finally it runs page-level custom code and the enter animation.
