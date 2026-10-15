/*!
 * Pageflow — page transitions for Webflow, with IX3/IX2 and custom code support.
 * https://github.com/devinscottfountain/pageflow
 * MIT License
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pageflow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.1';
  var ATTR = 'data-pageflow';

  // Lifecycle, in the order hooks run during a page change.
  var HOOKS = [
    'once', 'before', 'beforeLeave', 'leave', 'afterLeave',
    'beforeEnter', 'enter', 'afterEnter', 'after',
    'webflowReady', 'error'
  ];

  var defaults = {
    container: '[' + ATTR + '="container"]',
    transition: null,          // default preset when nothing else picks one
    duration: 400,             // ms, presets only
    easing: 'cubic-bezier(0.65, 0, 0.35, 1)',
    overlayColor: '#000',
    prefetch: true,
    cache: true,
    timeout: 10000,
    scrollToTop: true,
    reinitWebflow: true,
    rerunScripts: true,
    autoCleanup: true,         // remove window/document listeners and intervals that page scripts add
    ix3LeaveEvent: 'pageflow:leave',
    ix3EnterEvent: 'pageflow:enter',
    ix3MaxWait: 5000,          // ms cap when waiting for an IX3-designed transition
    exclude: null,             // function(url, link) => true to skip, or a RegExp tested against the path
    focus: true,
    announce: true,
    debug: false,
    transitions: []
  };

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  var opts = assign({}, defaults);
  var started = false;
  var running = false;
  var pendingNav = null;
  var listeners = {};
  var pageHandlers = [];
  var activeCleanups = [];
  var cache = new Map();
  var namedTransitions = {};
  var current = null;          // { url, namespace, container, doc }
  var historyIndex = 0;
  var scriptRegistry = null;   // texts and srcs of scripts that belong to the current page
  var loadedSrcs = new Set();
  var ownSrc = (document.currentScript && document.currentScript.src) || '';
  var initialRecords = [];   // listeners/intervals added by scripts during the first page load
  var liveRegion = null;

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (src) for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function log() {
    if (!opts.debug) return;
    var args = ['[Pageflow]'].concat([].slice.call(arguments));
    console.log.apply(console, args);
  }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function nextFrame() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function toURL(href) {
    try { return new URL(href, location.href); } catch (e) { return null; }
  }

  function cleanHref(url) {
    var u = typeof url === 'string' ? toURL(url) : url;
    if (!u) return '';
    return u.origin + u.pathname + u.search;
  }

  function hashText(str) {
    // Normalises whitespace so harmless formatting differences don't count as a different script.
    return String(str || '').replace(/\s+/g, ' ').trim();
  }

  function attr(el, name) {
    return el && el.getAttribute ? el.getAttribute(ATTR + '-' + name) : null;
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function on(name, fn) {
    (listeners[name] = listeners[name] || []).push(fn);
    return function () { off(name, fn); };
  }

  function off(name, fn) {
    if (!listeners[name]) return;
    listeners[name] = fn ? listeners[name].filter(function (f) { return f !== fn && f._orig !== fn; }) : [];
  }

  function once(name, fn) {
    var wrapped = function () { off(name, wrapped); return fn.apply(this, arguments); };
    wrapped._orig = fn;
    return on(name, wrapped);
  }

  function emit(name, data) {
    var fns = (listeners[name] || []).slice();
    try { document.dispatchEvent(new CustomEvent('pageflow:' + name, { detail: data })); } catch (e) {}
    return fns.reduce(function (p, fn) {
      return p.then(function () { return fn(data); });
    }, Promise.resolve()).catch(function (err) {
      console.error('[Pageflow] Error in "' + name + '" hook:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Link handling
  // ---------------------------------------------------------------------------

  function findLink(target) {
    var el = target && target.closest ? target.closest('a[href]') : null;
    return el;
  }

  function shouldHandle(link, event) {
    if (!link) return false;
    if (event && (event.defaultPrevented || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return false;
    if (link.hasAttribute(ATTR + '-prevent') || link.closest('[' + ATTR + '-prevent="all"]')) return false;
    if (link.target && link.target !== '_self') return false;
    if (link.hasAttribute('download')) return false;
    var rel = (link.getAttribute('rel') || '').toLowerCase();
    if (rel.indexOf('external') > -1) return false;
    // Webflow lightboxes, dropdown toggles and e-commerce flows manage their own clicks.
    if (link.closest('.w-lightbox, .w-commerce-commercecartopenlink, .w-commerce-commercecheckoutbutton')) return false;

    var raw = link.getAttribute('href');
    if (!raw || raw.charAt(0) === '#' || /^(mailto|tel|sms|javascript):/i.test(raw)) return false;
    var url = toURL(link.href);
    if (!url || url.origin !== location.origin) return false;
    if (/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|docx?|xlsx?|csv)$/i.test(url.pathname)) return false;
    if (/^\/(checkout|order-confirmation|paypal-checkout|log-in|sign-up|user-account|reset-password|update-password)/.test(url.pathname)) return false;
    // Same page, different hash: let the browser scroll.
    if (url.hash && cleanHref(url) === cleanHref(location.href)) return false;
    if (typeof opts.exclude === 'function' && opts.exclude(url, link)) return false;
    if (opts.exclude instanceof RegExp && opts.exclude.test(url.pathname)) return false;
    return url;
  }

  function onClick(event) {
    var link = findLink(event.target);
    var url = shouldHandle(link, event);
    if (!url) return;
    event.preventDefault();
    if (cleanHref(url) === cleanHref(location.href) && !url.hash) return; // already here
    navigate(url.href, { trigger: link, transition: attr(link, 'transition') });
  }

  function onHover(event) {
    if (!opts.prefetch) return;
    var link = findLink(event.target);
    if (!link || link.hasAttribute(ATTR + '-no-prefetch')) return;
    var url = shouldHandle(link, null);
    if (url && cleanHref(url) !== cleanHref(location.href)) prefetch(url.href);
  }

  function onPopState(event) {
    var url = location.href;
    if (cleanHref(url) === cleanHref(current.url)) return; // hash-only change
    var state = event.state && event.state.pageflow ? event.state : null;
    var direction = state && state.index < historyIndex ? 'back' : 'forward';
    if (state) historyIndex = state.index;
    navigate(url, { trigger: 'popstate', direction: direction, scroll: state ? state.scroll : null, push: false });
  }

  // ---------------------------------------------------------------------------
  // Fetching
  // ---------------------------------------------------------------------------

  function request(href) {
    var key = cleanHref(href);
    if (opts.cache && cache.has(key)) return cache.get(key);
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { controller && controller.abort(); }, opts.timeout);
    var p = fetch(href, {
      credentials: 'same-origin',
      headers: { 'Accept': 'text/html,application/xhtml+xml', 'x-pageflow': 'yes' },
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      clearTimeout(timer);
      var type = res.headers.get('content-type') || '';
      if (!res.ok || type.indexOf('text/html') === -1) throw new Error('Not an HTML page (' + res.status + ')');
      return res.text().then(function (html) { return { html: html, url: res.url || href }; });
    });
    p.catch(function () { cache.delete(key); });
    cache.set(key, p);
    return p;
  }

  function prefetch(href) {
    return request(href).catch(function () {});
  }

  // ---------------------------------------------------------------------------
  // Pages
  // ---------------------------------------------------------------------------

  function namespaceOf(container, doc) {
    if (!container) return '';
    var ns = attr(container, 'namespace');
    if (ns) return ns;
    var html = (doc || document).documentElement;
    return html.getAttribute('data-wf-page') || '';
  }

  function pageData(url, doc, container) {
    return { url: url, namespace: namespaceOf(container, doc), container: container, doc: doc };
  }

  // ---------------------------------------------------------------------------
  // Transitions
  // ---------------------------------------------------------------------------

  function animate(el, keyframes, options) {
    if (!el || !el.animate || options.duration === 0) {
      var last = keyframes[keyframes.length - 1];
      if (el) for (var k in last) el.style[k] = last[k];
      return Promise.resolve();
    }
    var a = el.animate(keyframes, assign({ fill: 'both' }, options));
    // Browsers pause animations in background tabs; never let that stall a page change.
    var limit = wait(options.duration + 1000).then(function () { try { a.finish(); } catch (e) {} });
    return Promise.race([a.finished, limit]).then(function () {
      // Keep the end state inline so cancelling the animation doesn't flash.
      var last = keyframes[keyframes.length - 1];
      for (var k in last) el.style[k] = last[k];
      a.cancel();
    }, function () {});
  }

  function clearInline(el, props) {
    props.forEach(function (p) { el.style[p] = ''; });
  }

  function overlayEl() {
    var el = document.querySelector('[' + ATTR + '="overlay"]');
    if (el) return { el: el, own: false };
    el = document.createElement('div');
    el.setAttribute(ATTR + '-generated-overlay', '');
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;transform:scaleY(0);';
    el.style.background = opts.overlayColor;
    document.body.appendChild(el);
    return { el: el, own: true };
  }

  function presetTiming(ctx) {
    var el = ctx.trigger && ctx.trigger.nodeType === 1 ? ctx.trigger : null;
    var d = parseInt(attr(el, 'duration') || attr(ctx.current.container, 'duration') || attr(document.documentElement, 'duration'), 10);
    var duration = reducedMotion() ? 0 : (isNaN(d) ? opts.duration : d);
    return { duration: duration, easing: opts.easing };
  }

  var presets = {
    none: { leave: function () {}, enter: function () {} },
    fade: {
      leave: function (d) { return animate(d.current.container, [{ opacity: 1 }, { opacity: 0 }], presetTiming(d)); },
      enter: function (d) {
        return animate(d.next.container, [{ opacity: 0 }, { opacity: 1 }], presetTiming(d))
          .then(function () { clearInline(d.next.container, ['opacity']); });
      }
    },
    'slide-up': {
      leave: function (d) {
        return animate(d.current.container, [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-32px)' }], presetTiming(d));
      },
      enter: function (d) {
        return animate(d.next.container, [{ opacity: 0, transform: 'translateY(32px)' }, { opacity: 1, transform: 'translateY(0)' }], presetTiming(d))
          .then(function () { clearInline(d.next.container, ['opacity', 'transform']); });
      }
    },
    'slide-left': {
      leave: function (d) {
        var dir = d.direction === 'back' ? 1 : -1;
        return animate(d.current.container, [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(' + (dir * 48) + 'px)' }], presetTiming(d));
      },
      enter: function (d) {
        var dir = d.direction === 'back' ? -1 : 1;
        return animate(d.next.container, [{ opacity: 0, transform: 'translateX(' + (dir * 48) + 'px)' }, { opacity: 1, transform: 'translateX(0)' }], presetTiming(d))
          .then(function () { clearInline(d.next.container, ['opacity', 'transform']); });
      }
    },
    overlay: {
      leave: function (d) {
        var o = overlayEl();
        d._overlay = o;
        o.el.style.transformOrigin = 'bottom';
        o.el.style.pointerEvents = 'auto';
        return animate(o.el, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], presetTiming(d));
      },
      enter: function (d) {
        var o = d._overlay || overlayEl();
        o.el.style.transformOrigin = 'top';
        return animate(o.el, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0)' }], presetTiming(d)).then(function () {
          o.el.style.pointerEvents = 'none';
          if (o.own) o.el.remove();
        });
      }
    },
    ix3: {
      leave: function (d) { return playIx3Event(opts.ix3LeaveEvent, d, 'leave'); },
      enter: function (d) { return playIx3Event(opts.ix3EnterEvent, d, 'enter'); }
    }
  };

  function resolveTransition(ctx) {
    // 1. Custom transitions passed to init(), first match wins.
    var list = opts.transitions || [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!matchesRule(t.from, ctx.current) || !matchesRule(t.to, ctx.next)) continue;
      if (typeof t.custom === 'function' && !t.custom(ctx)) continue;
      return t;
    }
    // 2. A named transition from an attribute: link, then incoming page, then outgoing page, then <html>/<body>.
    var name = ctx.requested ||
      attr(ctx.next.container, 'transition') ||
      attr(ctx.current.container, 'transition') ||
      attr(document.body, 'transition') ||
      attr(document.documentElement, 'transition') ||
      opts.transition || 'fade';
    var def = namedTransitions[name] || presets[name];
    if (!def) {
      console.warn('[Pageflow] Unknown transition "' + name + '", using fade.');
      def = presets.fade;
    }
    return def;
  }

  function matchesRule(rule, page) {
    if (!rule) return true;
    var ns = rule.namespace;
    if (ns && [].concat(ns).indexOf(page.namespace) === -1) return false;
    if (rule.path) {
      var path = toURL(page.url).pathname;
      if (rule.path instanceof RegExp ? !rule.path.test(path) : rule.path !== path) return false;
    }
    if (typeof rule.custom === 'function' && !rule.custom(page)) return false;
    return true;
  }

  function call(fn, ctx) {
    if (typeof fn !== 'function') return Promise.resolve();
    try { return Promise.resolve(fn.call(ctx.transition || null, ctx)); } catch (e) { return Promise.reject(e); }
  }

  // ---------------------------------------------------------------------------
  // IX3-designed transitions
  // ---------------------------------------------------------------------------

  function ix3Module() {
    try { return window.Webflow && window.Webflow.require && window.Webflow.require('ix3'); } catch (e) { return null; }
  }

  function ix3Instance() {
    var m = ix3Module();
    return m && m.getInstance ? m.getInstance() : null;
  }

  function containsString(value, needle) {
    if (value === needle) return true;
    if (Array.isArray(value)) return value.some(function (v) { return containsString(v, needle); });
    if (value && typeof value === 'object') {
      for (var k in value) if (containsString(value[k], needle)) return true;
    }
    return false;
  }

  // Estimates how long the IX3 timelines bound to a custom event take, from IX3's own data.
  function estimateIx3Duration(eventName) {
    var inst = ix3Instance();
    if (!inst || !inst.interactions || !inst.timelineDefs) return 0;
    var longest = 0;
    inst.interactions.forEach(function (ix) {
      if (!containsString(ix.triggers, eventName)) return;
      (ix.timelineIds || []).forEach(function (id) {
        var tl = inst.timelineDefs.get(id);
        if (!tl) return;
        (tl.actions || []).forEach(function (a) {
          var t = a.timing || {};
          var end = (t.position || 0) + (t.duration == null ? 0.5 : t.duration);
          if (t.stagger) {
            if (t.stagger.amount) end += t.stagger.amount;
            else if (t.stagger.each) end += t.stagger.each * Math.max(0, countTargets(a.targets) - 1);
          }
          longest = Math.max(longest, end);
        });
      });
    });
    return longest * 1000;
  }

  function countTargets(targets) {
    var n = 0;
    (targets || []).forEach(function (t) {
      if (Array.isArray(t) && t[0] === 'wf:class' && Array.isArray(t[1])) {
        n += document.getElementsByClassName(t[1][0]).length;
      }
    });
    return n || 1;
  }

  function playIx3Event(eventName, ctx, phase) {
    var m = ix3Module();
    if (!m || typeof m.emit !== 'function') {
      log('IX3 not available, skipping', phase);
      return Promise.resolve();
    }
    var el = ctx.trigger && ctx.trigger.nodeType === 1 ? ctx.trigger : null;
    var override = parseInt(attr(el, 'duration') || attr(ctx.next.container, 'duration') || attr(document.documentElement, 'duration'), 10);
    var estimate = isNaN(override) ? estimateIx3Duration(eventName) : override;
    var gsap = window.gsap;
    // Which timelines existed before the event, and whether they could be the ones it starts:
    // paused or finished ones can be (re)played by it; fresh, already-running ones (like a page
    // load animation that just got registered) belong to something else.
    var before = new Map();
    if (gsap) gsap.globalTimeline.getChildren(false, true, true).forEach(function (t) {
      before.set(t, !t.isActive() && (t.paused() || t.progress() === 1));
    });
    m.emit(eventName, { phase: phase, from: ctx.current.namespace, to: ctx.next.namespace });
    log('IX3 emit', eventName, 'estimate', estimate + 'ms');
    if (!gsap || !isNaN(override)) return wait(Math.min(estimate, opts.ix3MaxWait));
    // Wait for whatever GSAP started because of the event; the estimate is the fallback.
    return nextFrame().then(function () {
      var started = gsap.globalTimeline.getChildren(false, true, true).filter(function (t) {
        if (!t.isActive() || t.repeat() === -1) return false;
        return !before.has(t) || before.get(t);
      });
      var cap = wait(opts.ix3MaxWait);
      if (!started.length) return Promise.race([wait(estimate), cap]);
      return Promise.race([Promise.all(started.map(function (t) { return t.then(); })), cap]);
    });
  }

  // ---------------------------------------------------------------------------
  // <head>, <html> and <body> sync
  // ---------------------------------------------------------------------------

  var HEAD_SELECTORS = [
    'meta[name="description"]', 'meta[name="robots"]', 'meta[name^="twitter:"]',
    'meta[property^="og:"]', 'link[rel="canonical"]', 'link[rel="alternate"]',
    'script[type="application/ld+json"]'
  ].join(',');

  function syncHead(nextDoc) {
    document.title = nextDoc.title;
    var head = document.head;
    head.querySelectorAll(HEAD_SELECTORS).forEach(function (el) { el.remove(); });
    nextDoc.head.querySelectorAll(HEAD_SELECTORS).forEach(function (el) { head.appendChild(document.importNode(el, true)); });

    // Page-level <style> and stylesheet links: add the incoming page's, drop the outgoing page's.
    var keep = new Set();
    nextDoc.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(function (el) {
      var key = styleKey(el);
      keep.add(key);
      if (!findStyle(key)) {
        var clone = document.importNode(el, true);
        clone.setAttribute(ATTR + '-page-style', '');
        head.appendChild(clone);
      }
    });
    // Only styles Pageflow added (or marked data-pageflow-page-style) are removed; styles that
    // other scripts injected at runtime are left alone.
    head.querySelectorAll('[' + ATTR + '-page-style]').forEach(function (el) {
      if (!keep.has(styleKey(el))) el.remove();
    });
  }

  function styleKey(el) {
    return el.tagName === 'LINK' ? 'link:' + el.href : 'style:' + hashText(el.textContent);
  }

  function findStyle(key) {
    var found = null;
    document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(function (el) {
      if (styleKey(el) === key) found = el;
    });
    return found;
  }

  var HTML_ATTRS = ['data-wf-page', 'data-wf-item-slug', 'data-wf-collection', 'data-wf-status', 'lang'];

  function syncRootAttributes(nextDoc) {
    var html = document.documentElement;
    HTML_ATTRS.forEach(function (name) {
      var v = nextDoc.documentElement.getAttribute(name);
      if (v == null) html.removeAttribute(name); else html.setAttribute(name, v);
    });
    // Body classes and attributes are set per page in Webflow (page-level body class, data attributes).
    var body = document.body, nextBody = nextDoc.body;
    var preserved = [].filter.call(body.classList, function (c) { return /^(w-mod-|pageflow-)/.test(c); });
    body.className = nextBody.className;
    preserved.forEach(function (c) { body.classList.add(c); });
    [].slice.call(body.attributes).forEach(function (a) {
      if (a.name !== 'class' && a.name.indexOf(ATTR) !== 0 && !nextBody.hasAttribute(a.name)) body.removeAttribute(a.name);
    });
    [].slice.call(nextBody.attributes).forEach(function (a) {
      if (a.name !== 'class') body.setAttribute(a.name, a.value);
    });
  }

  // ---------------------------------------------------------------------------
  // Webflow re-initialisation
  // ---------------------------------------------------------------------------

  function isWebflowEntry(src) {
    return /\/js\/webflow\.[^/]*\.js(\?|$)/.test(src) && !/webflow\.[a-z]*chunk\./.test(src);
  }

  function isWebflowChunk(src) {
    return /\/js\/webflow\.[a-z]*chunk\.[^/]*\.js(\?|$)/.test(src);
  }

  function isOwnScript(src) {
    // Also matches Webflow-hosted copies, which get an id prefix ("…_pageflow.min.js").
    return !!src && (src === ownSrc || /[\/_-]pageflow(\.min)?\.js(\?|$)/.test(src));
  }

  function loadScript(src, attrs) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      if (attrs) [].forEach.call(attrs, function (a) {
        if (a.name !== 'src' && a.name !== 'integrity') s.setAttribute(a.name, a.value);
      });
      s.async = false;
      s.src = src;
      s.onload = function () { resolve(s); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.body.appendChild(s);
    });
  }

  function snapshotIx3() {
    var inst = ix3Instance();
    if (!inst || !inst.interactions || !inst.timelineDefs) return null;
    return { interactions: Array.from(inst.interactions.values()), timelines: Array.from(inst.timelineDefs.values()) };
  }

  function waitForIx3Ready(ms) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(v) { if (!done) { done = true; window.removeEventListener('__wf_ix3_ready', onReady); resolve(v); } }
      function onReady() { finish(true); }
      window.addEventListener('__wf_ix3_ready', onReady);
      setTimeout(function () { finish(false); }, ms);
    });
  }

  // Elements outside the container stay on screen through a page change, but re-registering IX3
  // re-applies each interaction's starting state to them (a transition panel would jump back to
  // where it rests). Their current GSAP state is saved before re-init and put back afterwards.
  var GSAP_PROPS = ['x', 'y', 'xPercent', 'yPercent', 'scaleX', 'scaleY', 'rotation', 'rotationX', 'rotationY', 'skewX', 'skewY', 'opacity'];

  function capturePersistentState() {
    var gsap = window.gsap;
    if (!gsap) return [];
    var saved = [];
    document.body.querySelectorAll('*').forEach(function (el) {
      if (!el._gsap || el.closest(opts.container)) return;
      var vals = {};
      GSAP_PROPS.forEach(function (p) { vals[p] = gsap.getProperty(el, p); });
      vals.visibility = el.style.visibility || '';
      saved.push({ el: el, vals: vals });
    });
    return saved;
  }

  function restorePersistentState(saved) {
    var gsap = window.gsap;
    if (!gsap) return;
    saved.forEach(function (s) { if (s.el.isConnected) gsap.set(s.el, s.vals); });
  }

  // Re-starts Webflow (components, IX2 and IX3) for the page now in the DOM.
  // Verified approach: destroy Webflow, clear window.Webflow, and execute the incoming page's
  // own webflow bundle, which defines its modules and registers its IX3 interactions again.
  function reinitWebflow(nextDoc) {
    var W = window.Webflow;
    if (!W || typeof W.destroy !== 'function') return Promise.resolve();
    var snapshot = snapshotIx3();
    var persistent = capturePersistentState();
    var entries = [], chunks = [];
    (nextDoc || document).querySelectorAll('script[src]').forEach(function (s) {
      var src = s.getAttribute('src');
      var abs = toURL(src).href;
      if (isWebflowChunk(abs)) chunks.push(s);
      else if (isWebflowEntry(abs)) entries.push(s);
    });

    // Chunks hold shared module code; they only need to be on the page once.
    var chunkLoads = chunks.filter(function (s) { return !loadedSrcs.has(toURL(s.getAttribute('src')).href); })
      .map(function (s) {
        var src = toURL(s.getAttribute('src')).href;
        loadedSrcs.add(src);
        return loadScript(src, s.attributes);
      });

    return Promise.all(chunkLoads).then(function () {
      try { W.destroy(); } catch (e) { log('Webflow.destroy failed', e); }
      // destroy() reverts GSAP state; put persistent elements straight back so nothing jumps.
      restorePersistentState(persistent);

      if (!entries.length) {
        // No bundle to execute (e.g. exported site with a single webflow.js): restart in place.
        try { W.ready(); } catch (e) {}
        try { var ix2 = W.require('ix2'); ix2 && ix2.init && ix2.init(); } catch (e) {}
        var m = ix3Module();
        if (m && snapshot) {
          return Promise.resolve(m.ready()).then(function () {
            var inst = m.getInstance();
            if (inst && inst.interactions.size === 0) inst.register(snapshot.interactions, snapshot.timelines);
          });
        }
        return;
      }

      window.Webflow = [];
      // IX3 re-applies starting states when the bundle registers its interactions; undo that for
      // persistent elements in the same task, before the browser paints.
      var onIx3Ready = function () { restorePersistentState(persistent); };
      window.addEventListener('__wf_ix3_ready', onIx3Ready, { once: true });
      var hadIx3 = !!snapshot;
      var ready = hadIx3 ? waitForIx3Ready(3000) : Promise.resolve(true);
      return entries.reduce(function (p, s) {
        return p.then(function () { return loadScript(toURL(s.getAttribute('src')).href, s.attributes); });
      }, Promise.resolve()).then(function () {
        return ready;
      }).then(function (gotReady) {
        // Safety net: if the bundle didn't register anything but we had interactions, restore them.
        var m = ix3Module();
        if (m && snapshot && !gotReady) {
          return Promise.resolve(m.ready()).then(function () {
            var inst = m.getInstance();
            if (inst && inst.interactions.size === 0) inst.register(snapshot.interactions, snapshot.timelines);
          });
        }
      });
    }).then(function () {
      restorePersistentState(persistent);
      try { document.dispatchEvent(new Event('readystatechange')); } catch (e) {}
      if (window.ScrollTrigger && window.ScrollTrigger.refresh) window.ScrollTrigger.refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Custom code
  // ---------------------------------------------------------------------------

  // Webflow and library scripts that must never be executed twice by Pageflow.
  function isPlatformScript(el) {
    var src = el.getAttribute('src') || '';
    if (src) {
      var abs = toURL(src) ? toURL(src).href : src;
      if (isOwnScript(abs) || isWebflowEntry(abs) || isWebflowChunk(abs)) return true;
      if (/jquery[-.\d]*(\.min)?\.js/i.test(abs) || /webfont(\.min)?\.js/.test(abs)) return true;
      return false;
    }
    var text = el.textContent;
    // Webflow's own inline snippets: the w-mod-js class setter and the WebFont loader.
    if (/w-mod-js|WebFont\.load\(/.test(text) && text.length < 2000) return true;
    return false;
  }

  function isExecutable(el) {
    var type = (el.getAttribute('type') || '').trim().toLowerCase();
    return !type || type === 'text/javascript' || type === 'application/javascript' || type === 'module';
  }

  function scriptKey(el) {
    var src = el.getAttribute('src');
    return src ? 'src:' + (toURL(src) ? toURL(src).href : src) : 'inline:' + hashText(el.textContent);
  }

  // Records which scripts the current page came with, so the next page's scripts can be compared.
  function registryFrom(doc) {
    var set = new Set();
    doc.querySelectorAll('script').forEach(function (s) { set.add(scriptKey(s)); });
    return set;
  }

  // Runs a script element from the incoming page. Inline code is wrapped in a block so top-level
  // let/const/class declarations don't collide with the same code from an earlier visit.
  function runScript(el, place) {
    var s = document.createElement('script');
    [].forEach.call(el.attributes, function (a) {
      if (a.name !== 'integrity') s.setAttribute(a.name, a.value);
    });
    var src = el.getAttribute('src');
    if (src) {
      var abs = toURL(src).href;
      if (loadedSrcs.has(abs) && !el.hasAttribute(ATTR + '-rerun')) return Promise.resolve();
      loadedSrcs.add(abs);
      // External code runs after it downloads, so tracking stays on until then.
      var end = beginTracking();
      return new Promise(function (resolve) {
        s.async = false;
        s.onload = s.onerror = function () { end(); resolve(); };
        place.appendChild(s);
      });
    }
    var code = el.textContent;
    var isModule = (el.getAttribute('type') || '').toLowerCase() === 'module';
    if (!isModule && !el.hasAttribute(ATTR + '-no-scope')) code = '{\n' + code + '\n}';
    s.textContent = code;
    var stop = beginTracking();
    try { place.appendChild(s); } finally { stop(); }
    return Promise.resolve();
  }

  // While page code runs: DOMContentLoaded/load listeners fire right away (those events already
  // happened), and window/document listeners plus intervals are recorded for cleanup on leave.
  var trackingDepth = 0;

  function beginTracking() {
    var origWin = window.addEventListener, origDoc = document.addEventListener, origInterval = window.setInterval;
    var onloadBefore = window.onload;
    var recorded = [];
    var ended = false;
    function patch(target, orig) {
      return function (type, handler, options) {
        if ((this === window || this === document) &&
            (type === 'DOMContentLoaded' || type === 'load' || type === 'readystatechange') &&
            (typeof handler === 'function' || (handler && typeof handler.handleEvent === 'function'))) {
          var self = this;
          setTimeout(function () {
            try {
              var ev = new Event(type);
              typeof handler === 'function' ? handler.call(self, ev) : handler.handleEvent(ev);
            } catch (e) { console.error(e); }
          }, 0);
          return;
        }
        if (this === target) recorded.push(function () { target.removeEventListener(type, handler, options); });
        return orig.apply(this, arguments);
      };
    }
    trackingDepth++;
    window.addEventListener = patch(window, origWin);
    document.addEventListener = patch(document, origDoc);
    window.setInterval = function () {
      var id = origInterval.apply(window, arguments);
      recorded.push(function () { clearInterval(id); });
      return id;
    };
    return function end() {
      if (ended) return;
      ended = true;
      trackingDepth--;
      window.addEventListener = origWin;
      document.addEventListener = origDoc;
      window.setInterval = origInterval;
      if (window.onload && window.onload !== onloadBefore) {
        var handler = window.onload;
        setTimeout(function () { try { handler.call(window, new Event('load')); } catch (e) { console.error(e); } }, 0);
      }
      if (opts.autoCleanup) activeCleanups.push.apply(activeCleanups, recorded);
    };
  }

  // Runs the incoming page's custom code: scripts outside the container that the outgoing page
  // didn't have (page-level custom code), then scripts inside the container (embeds).
  function runPageScripts(nextDoc, container) {
    if (!opts.rerunScripts) return Promise.resolve();
    var previous = scriptRegistry || registryFrom(document);
    var queue = [];
    var nextContainer = nextDoc.querySelector(opts.container);

    nextDoc.querySelectorAll('script').forEach(function (el) {
      if (!isExecutable(el) || isPlatformScript(el)) return;
      if (el.hasAttribute(ATTR + '-skip')) return;
      var inContainer = nextContainer && nextContainer.contains(el);
      if (inContainer) return; // handled below, from the live container
      var force = el.hasAttribute(ATTR + '-rerun');
      if (!force && previous.has(scriptKey(el))) return; // site-wide code, already running
      queue.push({ el: el, place: el.closest('head') ? document.head : document.body });
    });

    // Scripts inside the container were inserted inert; replace each with a live copy in place.
    container.querySelectorAll('script').forEach(function (el) {
      if (!isExecutable(el) || el.hasAttribute(ATTR + '-skip')) return;
      queue.push({ el: el, place: null });
    });

    scriptRegistry = registryFrom(nextDoc);

    return queue.reduce(function (p, item) {
      return p.then(function () {
        if (item.place) return runScript(item.el, item.place);
        var holder = document.createElement('div');
        holder.style.display = 'none';
        item.el.parentNode.insertBefore(holder, item.el);
        item.el.remove();
        return runScript(item.el, holder).then(function () {
          // Leave the executed script where the original was.
          while (holder.firstChild) holder.parentNode.insertBefore(holder.firstChild, holder);
          holder.remove();
        });
      }).catch(function (err) { console.error('[Pageflow] Script error:', err); });
    }, Promise.resolve());
  }

  // Code that ran natively on the first page load wasn't run by Pageflow, so it couldn't be tracked
  // the usual way. While the document parses, listeners and intervals are recorded per script; on
  // the first page change, the ones from scripts the next page doesn't share (page-level code) are
  // removed, the same rule used to decide what re-runs.
  function trackInitialLoad() {
    if (document.readyState !== 'loading') return;
    var origWin = window.addEventListener, origDoc = document.addEventListener, origInterval = window.setInterval;
    function owner() {
      var s = document.currentScript;
      if (!s || isPlatformScript(s) || s.hasAttribute(ATTR + '-skip')) return null;
      return scriptKey(s);
    }
    function patch(target, orig) {
      return function (type, handler, options) {
        var key = this === target ? owner() : null;
        if (key) initialRecords.push({ key: key, undo: function () { target.removeEventListener(type, handler, options); } });
        return orig.apply(this, arguments);
      };
    }
    window.addEventListener = patch(window, origWin);
    document.addEventListener = patch(document, origDoc);
    window.setInterval = function () {
      var id = origInterval.apply(window, arguments);
      var key = owner();
      if (key) initialRecords.push({ key: key, undo: function () { clearInterval(id); } });
      return id;
    };
    origDoc.call(document, 'DOMContentLoaded', function () {
      window.addEventListener = origWin;
      document.addEventListener = origDoc;
      window.setInterval = origInterval;
    });
  }

  function cleanupInitialLoad(nextDoc) {
    if (!initialRecords.length || !opts.autoCleanup) { initialRecords = []; return; }
    var next = registryFrom(nextDoc);
    initialRecords.forEach(function (r) {
      if (!next.has(r.key)) { try { r.undo(); } catch (e) {} }
    });
    initialRecords = [];
  }

  function runCleanups() {
    var fns = activeCleanups.splice(0);
    fns.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  function runCleanups() {
    var fns = activeCleanups.splice(0);
    fns.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } });
  }

  // ---------------------------------------------------------------------------
  // Page handlers
  //   Pageflow.page(fn)               run on every page (first load and after each transition)
  //   Pageflow.page('namespace', fn)  run only on pages with that namespace
  //   Pageflow.onLeave(fn)            run once when leaving the current page
  // A handler may return a cleanup function, which runs when the page is left.
  // ---------------------------------------------------------------------------

  function page(namespace, fn) {
    if (typeof namespace === 'function') { fn = namespace; namespace = null; }
    var handler = { namespace: namespace, fn: fn, ranFor: null };
    pageHandlers.push(handler);
    var remove = function () { pageHandlers = pageHandlers.filter(function (h) { return h !== handler; }); };
    // Registered by page-level code that Pageflow is running: it belongs to this visit only.
    if (trackingDepth > 0) activeCleanups.push(remove);
    if (started && current && handlerMatches(handler, current)) runHandler(handler, current);
    return remove;
  }

  function onLeave(fn) {
    if (typeof fn === 'function') activeCleanups.push(fn);
  }

  function handlerMatches(h, pageInfo) {
    if (!h.namespace) return true;
    return [].concat(h.namespace).indexOf(pageInfo.namespace) > -1;
  }

  function runHandler(h, pageInfo) {
    if (h.ranFor === pageInfo) return;
    h.ranFor = pageInfo;
    try {
      var cleanup = h.fn({ namespace: pageInfo.namespace, url: pageInfo.url, container: pageInfo.container });
      if (typeof cleanup === 'function') activeCleanups.push(cleanup);
    } catch (e) { console.error('[Pageflow] page() handler error:', e); }
  }

  function runPageHandlers(pageInfo) {
    pageHandlers.slice().forEach(function (h) { if (handlerMatches(h, pageInfo)) runHandler(h, pageInfo); });
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  function navigate(href, o) {
    o = o || {};
    if (!started) { location.href = href; return Promise.resolve(); }
    if (running) {
      // Remember only the latest request and run it when the current transition finishes.
      pendingNav = { href: href, o: o };
      return Promise.resolve();
    }
    running = true;
    document.documentElement.classList.add('pageflow-running');

    var push = o.push !== false;
    var ctx = {
      trigger: o.trigger || 'api',
      direction: o.direction || 'forward',
      requested: o.transition || null,
      current: { url: current.url, namespace: current.namespace, container: current.container },
      next: { url: href, namespace: null, container: null }
    };

    if (push) {
      saveScroll();
      historyIndex++;
      history.pushState({ pageflow: true, index: historyIndex, scroll: { x: 0, y: 0 } }, '', href);
    }

    var fetching = request(href);
    var transition;

    return emit('before', ctx)
      .then(function () {
        // The transition can depend on the incoming page, so wait for it (usually already prefetched on hover).
        return fetching.then(parseInto(ctx));
      })
      .then(function () {
        transition = ctx.transition = resolveTransition(ctx);
        return emit('beforeLeave', ctx);
      })
      .then(function () {
        if (transition.sync) return null;
        return Promise.all([emit('leave', ctx).then(function () { return call(transition.leave, ctx); }), fetching.then(parseInto(ctx))]);
      })
      .then(function () {
        if (transition.sync) return fetching.then(parseInto(ctx));
      })
      .then(function () {
        if (!ctx.next.container) throw new Error('No ' + opts.container + ' on the incoming page');
        return emit('afterLeave', ctx);
      })
      .then(function () {
        runCleanups();
        cleanupInitialLoad(ctx.nextDoc);
        var oldContainer = ctx.current.container;
        var nextContainer = ctx.next.container;
        // Hidden until its enter animation starts, so it can't flash while Webflow re-initialises.
        nextContainer.style.visibility = 'hidden';
        if (transition.sync) {
          oldContainer.parentNode.insertBefore(nextContainer, oldContainer.nextSibling);
        } else {
          oldContainer.parentNode.replaceChild(nextContainer, oldContainer);
        }
        syncHead(ctx.nextDoc);
        syncRootAttributes(ctx.nextDoc);
        current = { url: ctx.next.url, namespace: ctx.next.namespace, container: nextContainer };
        if (!transition.sync) restoreScroll(o, ctx);
        return emit('beforeEnter', ctx);
      })
      .then(function () {
        if (transition.sync) {
          return Promise.all([
            call(transition.leave, ctx).then(function () { ctx.current.container.remove(); }),
            afterSwap(ctx).then(function () { return emit('enter', ctx); }).then(function () { return startEnter(transition, ctx); })
          ]).then(function () { restoreScroll(o, ctx); });
        }
        return afterSwap(ctx)
          .then(function () { return emit('enter', ctx); })
          .then(function () { return startEnter(transition, ctx); });
      })
      .then(function () { return emit('afterEnter', ctx); })
      .then(function () {
        accessibility(ctx);
        return emit('after', ctx);
      })
      .catch(function (err) {
        console.error('[Pageflow] Navigation failed, loading the page normally.', err);
        emit('error', { error: err, ctx: ctx });
        running = false;
        location.href = href;
        return new Promise(function () {}); // stop here; the browser is navigating
      })
      .then(function () {
        running = false;
        document.documentElement.classList.remove('pageflow-running');
        if (pendingNav) {
          var p = pendingNav; pendingNav = null;
          if (cleanHref(p.href) !== cleanHref(location.href)) navigate(p.href, p.o);
        }
      });
  }

  function startEnter(transition, ctx) {
    var p = call(transition.enter, ctx);
    ctx.next.container.style.visibility = '';
    return p;
  }

  function parseInto(ctx) {
    return function (res) {
      if (ctx.nextDoc) return;
      var doc = new DOMParser().parseFromString(res.html, 'text/html');
      var container = doc.querySelector(opts.container);
      ctx.nextDoc = doc;
      ctx.next.container = container ? document.adoptNode(container) : null;
      ctx.next.namespace = namespaceOf(container, doc);
      ctx.next.html = res.html;
      // Keep the address bar right if the server redirected.
      if (res.url && cleanHref(res.url) !== cleanHref(ctx.next.url)) {
        var finalUrl = toURL(res.url);
        finalUrl.hash = toURL(ctx.next.url).hash;
        ctx.next.url = finalUrl.href;
        history.replaceState(history.state, '', ctx.next.url);
      }
    };
  }

  // Everything that has to happen once the new container is in the DOM, before its enter animation.
  function afterSwap(ctx) {
    var reinit = opts.reinitWebflow ? reinitWebflow(ctx.nextDoc) : Promise.resolve();
    return reinit
      .catch(function (e) { console.error('[Pageflow] Webflow re-init failed:', e); })
      .then(function () { return emit('webflowReady', ctx); })
      .then(function () { return runPageScripts(ctx.nextDoc, ctx.next.container); })
      .then(function () { runPageHandlers(current); });
  }

  function saveScroll() {
    var st = history.state || {};
    if (st.pageflow) {
      st.scroll = { x: window.scrollX, y: window.scrollY };
      history.replaceState(st, '', location.href);
    }
  }

  function restoreScroll(o, ctx) {
    if (o.scroll) { window.scrollTo(o.scroll.x, o.scroll.y); return; }
    var hash = toURL(ctx.next.url).hash;
    if (hash) {
      var target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target) { target.scrollIntoView(); return; }
    }
    if (opts.scrollToTop) window.scrollTo(0, 0);
  }

  function accessibility(ctx) {
    if (opts.announce) {
      if (!liveRegion) {
        liveRegion = document.createElement('div');
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('aria-atomic', 'true');
        liveRegion.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
        document.body.appendChild(liveRegion);
      }
      liveRegion.textContent = document.title;
    }
    if (opts.focus && ctx.trigger !== 'popstate') {
      var target = ctx.next.container.querySelector('h1') || ctx.next.container;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.style.outline = target.style.outline || 'none';
      try { target.focus({ preventScroll: true }); } catch (e) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------

  function init(options) {
    if (started) { assign(opts, options || {}); return api; }
    assign(opts, window.PageflowConfig || {}, options || {});
    if (!window.history || !window.history.pushState || !window.fetch || !window.DOMParser) return api;
    // Not in the Webflow Editor, where the page must stay a normal document.
    if (/[?&]edit\b/.test(location.search) || document.documentElement.classList.contains('w-editor')) return api;
    var container = document.querySelector(opts.container);
    if (!container) {
      log('No container found (' + opts.container + '); Pageflow is off on this page.');
      return api;
    }
    started = true;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

    current = pageData(location.href, document, container);
    scriptRegistry = registryFrom(document);
    document.querySelectorAll('script[src]').forEach(function (s) { loadedSrcs.add(s.src); });
    history.replaceState({ pageflow: true, index: 0, scroll: { x: window.scrollX, y: window.scrollY } }, '', location.href);

    document.addEventListener('click', onClick);
    document.addEventListener('mouseover', onHover, { passive: true });
    document.addEventListener('touchstart', onHover, { passive: true });
    document.addEventListener('focusin', onHover);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pagehide', saveScroll);

    var ctx = { trigger: 'load', current: { url: null, namespace: null, container: null }, next: current };
    var first = (opts.transitions || []).filter(function (t) { return typeof t.once === 'function' && matchesRule(t.to, current); })[0];
    runPageHandlers(current);
    emit('once', ctx).then(function () { return first ? call(first.once, assign(ctx, { transition: first })) : null; });
    log('started', VERSION, current.namespace);
    return api;
  }

  function destroy() {
    if (!started) return;
    started = false;
    document.removeEventListener('click', onClick);
    document.removeEventListener('mouseover', onHover);
    document.removeEventListener('touchstart', onHover);
    document.removeEventListener('focusin', onHover);
    window.removeEventListener('popstate', onPopState);
    window.removeEventListener('pagehide', saveScroll);
    if ('scrollRestoration' in history) history.scrollRestoration = 'auto';
    runCleanups();
  }

  function transition(name, def) {
    namedTransitions[name] = def;
    return api;
  }

  var api = {
    version: VERSION,
    init: init,
    destroy: destroy,
    go: function (href, o) { return navigate(toURL(href).href, assign({ transition: null }, o)); },
    prefetch: prefetch,
    on: on,
    off: off,
    once: once,
    page: page,
    onLeave: onLeave,
    transition: transition,
    reinitWebflow: function () { return reinitWebflow(document); },
    get current() { return current; },
    get options() { return opts; },
    get running() { return running; }
  };

  // Start automatically once the DOM is ready, unless <html data-pageflow-manual> is set.
  function autoStart() {
    if (document.documentElement.hasAttribute(ATTR + '-manual')) return;
    init();
  }
  if (typeof document !== 'undefined') {
    trackInitialLoad();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoStart);
    else setTimeout(autoStart, 0);
  }

  return api;
});
