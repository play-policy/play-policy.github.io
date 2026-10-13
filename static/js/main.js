/* Dexterity from Supervised Play: page behavior. Vanilla JS, no dependencies. */
(function () {
  'use strict';

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  var mm = function (q) { return window.matchMedia ? window.matchMedia(q) : { matches: false }; };
  var reduceMotion = mm('(prefers-reduced-motion: reduce)').matches;
  var narrowQuery = mm('(max-width: 960px)');
  var phoneQuery = mm('(max-width: 640px)');
  var hasIO = 'IntersectionObserver' in window;

  function onMedia(q, fn) {
    if (q.addEventListener) q.addEventListener('change', fn);
    else if (q.addListener) q.addListener(fn);
  }

  /* ------------------------------------------------------------ helpers */

  function attachSrc(video, preload) {
    if (!video || video.dataset.loaded) return;
    var src = video.dataset.src;
    if (!src) return;
    video.dataset.loaded = '1';
    if (preload) video.preload = preload;
    video.src = src;
  }

  function safePlay(video) {
    try {
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (e) { /* ignore */ }
  }

  function seekTo(video, t) {
    try { video.currentTime = t; } catch (e) { /* ignore */ }
  }

  function applyRate(video) {
    var r = parseFloat(video.dataset.rate || '1');
    if (r && r !== 1) {
      video.defaultPlaybackRate = r;
      video.playbackRate = r;
    }
  }

  function parseAspect(a) {
    if (!a) return null;
    if (typeof a === 'number' && isFinite(a) && a > 0) return [a, 1];
    if (Array.isArray(a) && a.length === 2) return [Number(a[0]), Number(a[1])];
    var m = String(a).match(/^\s*([\d.]+)\s*[:\/x]\s*([\d.]+)\s*$/);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }

  function entryAspect(e) {
    if (!e) return null;
    if (e.width && e.height) return [Number(e.width), Number(e.height)];
    return parseAspect(e.aspect);
  }

  function setAspect(el, wh) {
    if (!el || !wh || !wh[0] || !wh[1]) return;
    el.style.setProperty('--ar', wh[0] + ' / ' + wh[1]);
    var cell = el.closest('.eqcell');
    if (cell && el.classList.contains('vframe')) cell.style.setProperty('--grow', (wh[0] / wh[1]).toFixed(4));
  }

  function fitFrame(video) {
    if (video.videoWidth && video.videoHeight) {
      setAspect(video.closest('.vframe, .chart-frame'), [video.videoWidth, video.videoHeight]);
    }
  }

  function markMissing(video, label) {
    var f = video.closest('.vframe, .chart-frame');
    if (!f) return;
    f.classList.add('is-missing');
    f.setAttribute('data-missing', label || 'Clip not available yet');
  }

  function nameOf(src) {
    var m = String(src || '').match(/([^\/]+)\.(mp4|webm|mov)$/i);
    return m ? m[1] : '';
  }

  function loadJSON(url) {
    if (!window.fetch) return Promise.resolve(null);
    return fetch(url, { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function indexBy(data, listKey) {
    var map = {};
    if (!data) return map;
    var items = Array.isArray(data) ? data : (data[listKey] || data);
    if (Array.isArray(items)) {
      items.forEach(function (it) { if (it && it.name) map[it.name] = it; });
    } else if (items && typeof items === 'object') {
      Object.keys(items).forEach(function (k) {
        var v = items[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) map[v.name || k] = v;
      });
    }
    return map;
  }

  function initEqRows() {
    $$('.eqrow > .eqcell').forEach(function (cell) {
      var f = $('.vframe', cell);
      if (!f) return;
      var wh = parseAspect(f.style.getPropertyValue('--ar'));
      if (wh) cell.style.setProperty('--grow', (wh[0] / wh[1]).toFixed(4));
    });
  }

  function applyMediaSizes(mediaIndex) {
    $$('video[data-src]').forEach(function (v) {
      if (v.classList.contains('chart-video')) return;
      var m = mediaIndex[nameOf(v.dataset.src)];
      if (m && m.width && m.height) setAspect(v.closest('.vframe'), [m.width, m.height]);
    });
  }

  /* ------------------------------------------------------------ lightbox */

  var lb = {
    root: $('#lightbox'),
    body: $('#lightboxBody'),
    cap: $('#lightboxCap'),
    close: $('#lightboxClose'),
    opener: null,
    paused: null
  };

  function openLightbox(node, opts) {
    if (!lb.root) return;
    opts = opts || {};
    lb.body.innerHTML = '';
    lb.body.appendChild(node);
    if (lb.cap) lb.cap.textContent = opts.caption || '';
    lb.root.hidden = false;
    document.body.classList.add('has-lightbox');
    lb.opener = opts.opener || null;
    lb.paused = null;
    if (opts.source && !opts.source.paused) {
      opts.source.pause();
      lb.paused = opts.source;
    }
    lb.close.focus();
  }

  function closeLightbox() {
    if (!lb.root || lb.root.hidden) return;
    var v = $('video', lb.body);
    if (v) v.pause();
    lb.body.innerHTML = '';
    lb.root.hidden = true;
    document.body.classList.remove('has-lightbox');
    if (lb.paused) safePlay(lb.paused);
    lb.paused = null;
    if (lb.opener && typeof lb.opener.focus === 'function') lb.opener.focus();
  }

  function expandVideo(src, opts) {
    opts = opts || {};
    var v = document.createElement('video');
    v.controls = true;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    if (opts.label) v.setAttribute('aria-label', opts.label);
    if (opts.poster) v.poster = opts.poster;
    v.addEventListener('loadedmetadata', function () {
      if (opts.time) seekTo(v, opts.time);
      if (opts.rate && opts.rate !== 1) {
        v.defaultPlaybackRate = opts.rate;
        v.playbackRate = opts.rate;
      }
    });
    v.src = src;
    openLightbox(v, opts);
    if (!reduceMotion || opts.userAction) safePlay(v);
  }

  function expandImage(img, opener) {
    var im = document.createElement('img');
    im.src = img.currentSrc || img.src;
    im.alt = img.alt || '';
    var fig = img.closest('figure');
    var cap = fig && $('figcaption', fig);
    openLightbox(im, { opener: opener, caption: cap ? cap.textContent : img.alt });
  }

  if (lb.root) {
    lb.close.addEventListener('click', closeLightbox);
    lb.root.addEventListener('click', function (e) {
      if (e.target === lb.root || e.target === lb.body) closeLightbox();
    });
    document.addEventListener('keydown', function (e) {
      if (lb.root.hidden) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeLightbox();
      } else if (e.key === 'Tab') {
        var focusables = [lb.close].concat($$('video, button, a', lb.body));
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    });
  }

  function captionFor(video) {
    if (video.dataset.caption) return video.dataset.caption;
    var fig = video.closest('figure');
    var cap = fig && $('figcaption', fig);
    return cap ? cap.textContent.trim() : (video.getAttribute('aria-label') || '');
  }

  function makeExpandable(video) {
    var f = video.closest('.vframe');
    if (!f || f.dataset.expandable) return;
    f.dataset.expandable = '1';
    f.classList.add('is-clickable');
    f.tabIndex = 0;
    f.setAttribute('role', 'button');
    f.setAttribute('aria-label', 'Open a larger view: ' + (video.getAttribute('aria-label') || 'video'));
    var open = function () {
      var src = video.currentSrc || video.dataset.src;
      if (!src) return;
      expandVideo(src, {
        time: video.currentTime || 0,
        rate: video.playbackRate || 1,
        label: video.getAttribute('aria-label'),
        poster: video.getAttribute('poster'),
        caption: captionFor(video),
        opener: f,
        source: video,
        userAction: true
      });
    };
    f.addEventListener('click', function (e) {
      if (e.target.closest('button')) return;
      open();
    });
    f.addEventListener('keydown', function (e) {
      if (e.target !== f) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  function makeImageExpandable(img) {
    var f = img.closest('.vframe');
    if (!f || f.dataset.expandable) return;
    f.dataset.expandable = '1';
    f.classList.add('is-clickable');
    f.tabIndex = 0;
    f.setAttribute('role', 'button');
    f.setAttribute('aria-label', 'Open a larger view: ' + (img.alt || 'image'));
    f.addEventListener('click', function () { expandImage(img, f); });
    f.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        expandImage(img, f);
      }
    });
  }

  /* ------------------------------------------------------------ autoplay videos */

  function addPlayButton(video) {
    var f = video.closest('.vframe');
    if (!f || $('.vplay', f)) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'vplay';
    b.textContent = 'Play';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      attachSrc(video, 'auto');
      if (video.paused) {
        video.dataset.userPlay = '1';
        safePlay(video);
      } else {
        delete video.dataset.userPlay;
        video.pause();
      }
    });
    video.addEventListener('play', function () { b.textContent = 'Pause'; });
    video.addEventListener('pause', function () { b.textContent = 'Play'; });
    f.appendChild(b);
  }

  function useStartOffset(video) {
    var t0 = parseFloat(video.dataset.t0 || '0') || 0;
    if (!t0) return;
    video.loop = false;
    video.addEventListener('loadedmetadata', function () {
      if (t0 < (video.duration || 0) && video.currentTime < t0) seekTo(video, t0);
    });
    video.addEventListener('ended', function () {
      seekTo(video, t0);
      if (video.dataset.visible === '1') safePlay(video);
    });
  }

  function initAutoplay() {
    var vids = $$('video[data-src]').filter(function (v) {
      return !v.hasAttribute('data-manual') && !v.classList.contains('chart-video');
    });

    vids.forEach(function (v) {
      v.addEventListener('error', function () { markMissing(v); });
      v.addEventListener('loadedmetadata', function () {
        applyRate(v);
        fitFrame(v);
      });
      v.addEventListener('play', function () { applyRate(v); });
      useStartOffset(v);
      makeExpandable(v);
      if (reduceMotion) addPlayButton(v);
    });

    if (!hasIO) {
      vids.forEach(function (v) {
        attachSrc(v, 'metadata');
        v.dataset.visible = '1';
        if (!reduceMotion) safePlay(v);
      });
      return;
    }

    var near = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          attachSrc(e.target, reduceMotion ? 'metadata' : 'auto');
          near.unobserve(e.target);
        }
      });
    }, { rootMargin: '400px 0px' });

    var vis = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var v = e.target;
        var on = e.isIntersecting && e.intersectionRatio >= 0.4;
        v.dataset.visible = on ? '1' : '0';
        if (on) {
          if (!reduceMotion || v.dataset.userPlay) {
            attachSrc(v, 'auto');
            safePlay(v);
          }
        } else if (!v.paused) {
          v.pause();
        }
      });
    }, { threshold: [0, 0.4, 0.6] });

    vids.forEach(function (v) {
      near.observe(v);
      vis.observe(v);
    });
  }

  /* ------------------------------------------------------------ synced pair (stage 2) */

  function initSyncPairs() {
    $$('[data-sync]').forEach(function (group) {
      var vids = $$('video', group);
      var visible = false;
      vids.forEach(function (v) {
        v.loop = false;
        v.addEventListener('error', function () { markMissing(v); });
        v.addEventListener('loadedmetadata', function () { fitFrame(v); });
        makeExpandable(v);
        if (reduceMotion) addPlayButton(v);
      });

      function restart() {
        vids.forEach(function (v) { seekTo(v, parseFloat(v.dataset.t0 || '0') || 0); });
        if (!reduceMotion) vids.forEach(safePlay);
      }

      vids.forEach(function (v) {
        v.addEventListener('ended', function () { if (visible) restart(); });
      });

      function whenReady(cb) {
        var pending = vids.filter(function (v) { return v.readyState < 1; });
        if (!pending.length) { cb(); return; }
        var left = pending.length;
        pending.forEach(function (v) {
          v.addEventListener('loadedmetadata', function () {
            left -= 1;
            if (!left) cb();
          }, { once: true });
        });
      }

      if (!hasIO) {
        vids.forEach(function (v) { attachSrc(v, 'auto'); });
        visible = true;
        whenReady(restart);
        return;
      }
      var started = false;
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          visible = e.isIntersecting && e.intersectionRatio >= 0.4;
          if (visible) {
            vids.forEach(function (v) { attachSrc(v, 'auto'); });
            whenReady(function () {
              if (!visible) return;
              if (!started) {
                started = true;
                restart();
              } else if (!reduceMotion) {
                vids.forEach(safePlay);
              }
            });
          } else {
            vids.forEach(function (v) { v.pause(); });
          }
        });
      }, { threshold: [0, 0.4, 0.7] });
      io.observe(group);
    });
  }

  /* ------------------------------------------------------------ nav */

  function initNav() {
    var nav = $('#nav');
    var bar = $('#navProgress');
    var burger = $('#navBurger');
    var burgerLabel = $('#navBurgerLabel');
    var links = $('#navLinks');
    if (!nav) return;

    var ticking = false;
    function update() {
      ticking = false;
      var doc = document.documentElement;
      var h = doc.scrollHeight - window.innerHeight;
      var p = h > 0 ? Math.min(1, Math.max(0, window.scrollY / h)) : 0;
      if (bar) bar.style.transform = 'scaleX(' + p.toFixed(4) + ')';
      nav.classList.toggle('is-scrolled', window.scrollY > 8);
    }
    window.addEventListener('scroll', function () {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }, { passive: true });
    window.addEventListener('resize', update);
    update();

    function setMenu(open) {
      if (!links || !burger) return;
      links.classList.toggle('is-open', open);
      burger.setAttribute('aria-expanded', String(open));
      if (burgerLabel) burgerLabel.textContent = open ? 'Close' : 'Menu';
    }

    if (burger && links) {
      burger.addEventListener('click', function () {
        setMenu(!links.classList.contains('is-open'));
      });
      document.addEventListener('click', function (e) {
        if (links.classList.contains('is-open') && !nav.contains(e.target)) setMenu(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && links.classList.contains('is-open')) {
          setMenu(false);
          burger.focus();
        }
      });
    }

    // In-page links land with the section heading just under the nav.
    document.addEventListener('click', function (e) {
      var a = e.target.closest('a[href^="#"]');
      if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey) return;
      var id = a.getAttribute('href').slice(1);
      if (links && links.contains(a)) setMenu(false);
      if (id === 'top') {
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        history.replaceState(null, '', '#top');
        return;
      }
      var target = id && document.getElementById(id);
      if (!target) return;
      var heading = target.matches('h1, h2, h3') ? target : $('h2, h3', target);
      var anchor = heading || target;
      e.preventDefault();
      var targetY = function () { return Math.max(0, anchor.getBoundingClientRect().top + window.scrollY - nav.offsetHeight - 20); };
      window.scrollTo({ top: targetY(), behavior: reduceMotion ? 'auto' : 'smooth' });
      history.replaceState(null, '', '#' + id);
      // Lazy media above the target can change height during the scroll; settle on the final position.
      var settle = function () {
        var y = targetY();
        if (Math.abs(window.scrollY - y) > 4) window.scrollTo({ top: y, behavior: 'auto' });
      };
      if ('onscrollend' in window) window.addEventListener('scrollend', settle, { once: true });
      else window.setTimeout(settle, 900);
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    });

    if (!hasIO || !links) return;
    var anchors = $$('a[data-spy]', links);
    var targets = anchors.map(function (a) { return document.getElementById(a.dataset.spy); }).filter(Boolean);
    var state = {};
    function mark() {
      var current = null;
      targets.forEach(function (t) { if (state[t.id]) current = t.id; });
      var doc = document.documentElement;
      if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) current = targets[targets.length - 1].id;
      anchors.forEach(function (a) {
        if (a.dataset.spy === current) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      });
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { state[e.target.id] = e.isIntersecting; });
      mark();
    }, { rootMargin: '-30% 0px -65% 0px', threshold: 0 });
    targets.forEach(function (t) { io.observe(t); });
    window.addEventListener('scroll', function () {
      var doc = document.documentElement;
      if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) mark();
    }, { passive: true });
  }

  /* ------------------------------------------------------------ chart videos */

  // Desktop and phone (portrait) render sizes; charts.json overrides these when it loads.
  var CHART_DIMS = {
    sim_baselines: [1600, 900, 1080, 1640],
    sim_efficiency: [1600, 900, 1080, 1240],
    real_vs_sim: [1600, 900, 1080, 1420],
    pusht: [1600, 900, 1080, 1140],
    rgb: [1600, 900, 1080, 900],
    scaling: [1600, 900, 1080, 1160],
    play_diversity: [1600, 460, 1080, 940],
    latency: [1600, 620, 1080, 800]
  };

  var REPLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5V1L7 6l5 5V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"/></svg>';

  function playChart(video, restart) {
    attachSrc(video, 'auto');
    video.dataset.played = '1';
    if (restart) seekTo(video, 0);
    safePlay(video);
  }

  function setupChart(fig) {
    var name = fig.dataset.chart;
    var video = $('.chart-video', fig);
    var frame = $('.chart-frame', fig);
    if (!video || !frame) return null;

    var dims = CHART_DIMS[name];
    var base = { video: video.dataset.src, poster: video.getAttribute('poster'), wh: dims ? [dims[0], dims[1]] : null };
    var phone = {
      video: 'static/charts/' + name + '_m.mp4',
      poster: 'static/charts/' + name + '_m.jpg',
      wh: dims ? [dims[2], dims[3]] : null
    };
    var hasPhone = !!dims;
    var current = null;

    // replay affordance inside the chart
    var glyph = document.createElement('span');
    glyph.className = 'chart-replay';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.innerHTML = REPLAY_ICON + 'Replay';
    frame.appendChild(glyph);
    frame.tabIndex = 0;
    frame.setAttribute('role', 'button');
    frame.setAttribute('aria-label', 'Replay the chart animation: ' + (video.getAttribute('aria-label') || name));
    var replay = function () {
      if (frame.classList.contains('is-missing')) return;
      playChart(video, true);
    };
    frame.addEventListener('click', replay);
    frame.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        replay();
      }
    });

    function applyVariant() {
      var want = (phoneQuery.matches && hasPhone) ? phone : base;
      if (current === want) return;
      var switching = current !== null;
      current = want;
      if (want.wh) setAspect(frame, want.wh);
      if (want.poster) video.setAttribute('poster', want.poster);
      video.dataset.src = want.video;
      if (switching && video.dataset.loaded) {
        var wasPlayed = !!video.dataset.played;
        delete video.dataset.loaded;
        attachSrc(video, 'auto');
        if (wasPlayed) {
          video.addEventListener('loadedmetadata', function () {
            seekTo(video, Math.max(0, (video.duration || 0) - 0.05));
          }, { once: true });
        }
      }
    }

    function update(entry) {
      if (!entry) return;
      base.wh = entryAspect(entry) || base.wh;
      if (entry.mobile && typeof entry.mobile === 'object') {
        hasPhone = true;
        phone.wh = entryAspect(entry.mobile) || phone.wh;
        if (typeof entry.mobile.video === 'string') phone.video = entry.mobile.video;
        if (typeof entry.mobile.poster === 'string') phone.poster = entry.mobile.poster;
      }
      if (current && current.wh) setAspect(frame, current.wh);
    }

    var posterOk = true;
    if (base.poster) {
      var probe = new Image();
      probe.onerror = function () { posterOk = false; };
      probe.src = base.poster;
    }

    video.addEventListener('loadedmetadata', function () { fitFrame(video); });
    video.addEventListener('error', function () {
      if (!posterOk) frame.classList.add('is-missing');
    });

    applyVariant();
    return { name: name, video: video, applyVariant: applyVariant, update: update };
  }

  function initCharts() {
    var charts = $$('.chart[data-chart]').map(setupChart).filter(Boolean);
    function applyAll() { charts.forEach(function (c) { c.applyVariant(); }); }
    onMedia(phoneQuery, applyAll);

    if (hasIO) {
      var near = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            attachSrc(e.target, 'auto');
            near.unobserve(e.target);
          }
        });
      }, { rootMargin: '500px 0px' });

      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target;
          if (e.isIntersecting && e.intersectionRatio >= 0.55 && !v.dataset.played && !reduceMotion) {
            playChart(v, false);
          }
        });
      }, { threshold: [0, 0.55, 0.8] });

      charts.forEach(function (c) {
        near.observe(c.video);
        io.observe(c.video);
      });
    }

    return {
      update: function (index) {
        charts.forEach(function (c) { c.update(index[c.name]); });
        applyAll();
      }
    };
  }

  /* ------------------------------------------------------------ pipeline scrollytelling */

  function initPipeline() {
    var fig = $('#plFigure');
    if (!fig) return;
    var regions = $$('.pl-region', fig);
    var stages = $$('.stage[data-stage]');

    function clear() {
      fig.classList.remove('has-active');
      regions.forEach(function (x) {
        x.classList.remove('is-active');
        x.removeAttribute('aria-current');
      });
    }

    function setActive(n) {
      if (narrowQuery.matches) return;
      fig.classList.add('has-active');
      regions.forEach(function (r) {
        var on = r.dataset.stage === String(n);
        r.classList.toggle('is-active', on);
        if (on) r.setAttribute('aria-current', 'step');
        else r.removeAttribute('aria-current');
      });
    }

    onMedia(narrowQuery, function () { if (narrowQuery.matches) clear(); });

    regions.forEach(function (r) {
      r.addEventListener('click', function () {
        var t = document.getElementById('stage-' + r.dataset.stage);
        setActive(r.dataset.stage);
        if (!t) return;
        var nav = $('#nav');
        var h = $('h3', t);
        var y = (h || t).getBoundingClientRect().top + window.scrollY - (nav ? nav.offsetHeight : 56) - 20;
        window.scrollTo({ top: Math.max(0, y), behavior: reduceMotion ? 'auto' : 'smooth' });
        if (h) {
          h.setAttribute('tabindex', '-1');
          h.focus({ preventScroll: true });
        }
      });
    });

    if (!hasIO) return;
    var inBand = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { inBand[e.target.dataset.stage] = e.isIntersecting; });
      var active = null;
      stages.forEach(function (s) { if (inBand[s.dataset.stage]) active = s.dataset.stage; });
      if (active) setActive(active);
    }, { rootMargin: '-42% 0px -52% 0px', threshold: 0 });
    stages.forEach(function (s) { io.observe(s); });

    var method = $('#method');
    if (method) {
      var outer = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting && e.boundingClientRect.top > 0) clear();
        });
      });
      outer.observe(method);
    }
  }

  /* ------------------------------------------------------------ world-model scrubber */

  function initWM() {
    var root = $('#wm');
    if (!root) return { setData: function () {} };
    var vids = $$('video', root);
    var range = $('#wmRange');
    var out = $('#wmReadout');
    var btn = $('#wmPlay');
    var FPS = 15;
    var last = parseInt(range.max, 10) || 30;
    var frame = 0;
    var playing = false;
    var userHold = false;
    var visible = false;
    var raf = 0;
    var acc = 0;
    var prevTs = 0;
    var errDeg = null;
    var tAhead = null;
    var fallback = false;

    function readout() {
      var t = tAhead && typeof tAhead[frame] === 'number' ? tAhead[frame] : frame / FPS;
      var s = '+' + t.toFixed(2) + ' s ahead';
      var spoken = t.toFixed(2) + ' seconds ahead';
      if (errDeg && typeof errDeg[frame] === 'number') {
        s += ', ' + errDeg[frame].toFixed(1) + '° error';
        spoken += ', ' + errDeg[frame].toFixed(1) + ' degrees of rotation error';
      }
      out.textContent = s;
      range.setAttribute('aria-valuetext', spoken);
    }

    function useFallback() {
      if (fallback) return;
      fallback = true;
      setPlaying(false);
      root.classList.add('is-fallback');
      range.disabled = true;
      out.textContent = 'scrubbing unavailable on this server';
      btn.textContent = reduceMotion ? 'Play' : 'Pause';
      vids.forEach(function (v) {
        v.loop = true;
        if (!reduceMotion) safePlay(v);
      });
    }

    vids.forEach(function (v) {
      v.addEventListener('error', function () {
        if (v.dataset.fallback && v.dataset.src !== v.dataset.fallback) {
          v.dataset.src = v.dataset.fallback;
          if (v.dataset.posterFallback) v.setAttribute('poster', v.dataset.posterFallback);
          delete v.dataset.loaded;
          attachSrc(v, 'auto');
        } else {
          markMissing(v);
        }
      });
      v.addEventListener('loadeddata', function () {
        var s = v.seekable;
        if (s && (s.length === 0 || s.end(s.length - 1) < (v.duration || 0) - 0.25)) useFallback();
      });
      v.addEventListener('loadedmetadata', function () {
        fitFrame(v);
        if (v.duration && isFinite(v.duration)) {
          var n = Math.max(1, Math.round(v.duration * FPS) - 1);
          if (n < last) {
            last = n;
            range.max = String(n);
          }
        }
        seek(frame);
      });
    });

    function load() { vids.forEach(function (v) { attachSrc(v, 'auto'); }); }

    function seek(i) {
      if (fallback) return;
      frame = Math.max(0, Math.min(last, i));
      var t = (frame + 0.5) / FPS;
      vids.forEach(function (v) {
        if (v.readyState >= 1) {
          var d = v.duration && isFinite(v.duration) ? v.duration : t + 1;
          seekTo(v, Math.min(t, d - 0.01));
        }
      });
      range.value = String(frame);
      readout();
    }

    function tick(ts) {
      if (!playing) return;
      if (!prevTs) prevTs = ts;
      acc += ts - prevTs;
      prevTs = ts;
      var step = 1000 / FPS;
      if (frame >= last) {
        if (acc > 900) {
          acc = 0;
          seek(0);
        }
      } else if (acc >= step) {
        acc -= step;
        if (acc > step) acc = 0;
        seek(frame + 1);
      }
      raf = window.requestAnimationFrame(tick);
    }

    function setPlaying(on) {
      playing = on;
      btn.textContent = on ? 'Pause' : 'Play';
      btn.setAttribute('aria-pressed', String(on));
      window.cancelAnimationFrame(raf);
      if (on) {
        load();
        prevTs = 0;
        acc = 0;
        raf = window.requestAnimationFrame(tick);
      }
    }

    btn.addEventListener('click', function () {
      if (fallback) {
        var anyPaused = vids.some(function (v) { return v.paused; });
        vids.forEach(function (v) { if (anyPaused) safePlay(v); else v.pause(); });
        btn.textContent = anyPaused ? 'Pause' : 'Play';
        return;
      }
      userHold = playing;
      setPlaying(!playing);
    });

    range.addEventListener('input', function () {
      load();
      userHold = true;
      if (playing) setPlaying(false);
      seek(parseInt(range.value, 10) || 0);
    });

    readout();

    if (!hasIO) {
      load();
    } else {
      var near = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            load();
            near.disconnect();
          }
        });
      }, { rootMargin: '400px 0px' });
      near.observe(root);

      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          visible = e.isIntersecting && e.intersectionRatio >= 0.35;
          if (fallback) return;
          if (visible && !userHold && !reduceMotion && !playing) setPlaying(true);
          if (!visible && playing) setPlaying(false);
        });
      }, { threshold: [0, 0.35, 0.7] });
      io.observe(root);
    }

    return {
      setData: function (d) {
        if (!d) return;
        if (Array.isArray(d.err_deg)) errDeg = d.err_deg;
        if (Array.isArray(d.t_ahead_s)) tAhead = d.t_ahead_s;
        readout();
      }
    };
  }

  /* ------------------------------------------------------------ MPC stepper */

  function initMPC() {
    var root = $('#mpc');
    if (!root) return;
    var steps = $$('.mpc-step', root);
    var autoBtn = $('#mpcAuto');
    var autoLabel = $('#mpcAutoLabel');
    var text = $('#mpcText');
    var stateTile = $('.mpc-state', root);
    var stateFrame = $('.mpc-frame', stateTile);
    var stateNow = $('.mpc-now', stateTile);
    var stateNext = $('.mpc-next', stateTile);
    var stateName = $('#mpcStateName');
    var props = $$('.mpc-prop', root);
    var vids = props.map(function (p) { return $('video', p); });
    var lasts = props.map(function (p) { return $('.mpc-last', p); });
    var bestIdx = props.findIndex(function (p) { return p.dataset.best === 'true'; });
    var TEXT = [
      'The play policy samples 1,024 goal-agnostic action chunks from the current state.',
      'The world model predicts all 1,024 outcomes in one batch.',
      'The goal is used only to score how close each predicted trajectory gets.',
      'The robot executes the start of the best chunk, and planning begins again from the new state.'
    ];
    var phase = 0;
    var auto = !reduceMotion;
    var inView = false;
    var timer = 0;
    var token = 0;

    if (stateNow && stateNow.dataset.fallback) {
      stateNow.addEventListener('error', function () {
        if (stateNow.src.indexOf(stateNow.dataset.fallback) < 0) stateNow.src = stateNow.dataset.fallback;
      });
    }
    lasts.forEach(function (img) {
      if (!img) return;
      img.addEventListener('error', function () { img.dataset.missing = '1'; img.hidden = true; });
    });

    vids.forEach(function (v) {
      v.loop = false;
      v.removeAttribute('loop');
      v.addEventListener('error', function () { markMissing(v); });
      v.addEventListener('loadedmetadata', function () { fitFrame(v); });
    });

    function setAutoUI() {
      autoLabel.textContent = auto ? 'Pause' : 'Resume';
      autoBtn.classList.toggle('is-paused', !auto);
      autoBtn.setAttribute('aria-label', auto ? 'Pause auto-advance' : 'Resume auto-advance');
    }

    function showLasts(on) {
      lasts.forEach(function (img, i) {
        if (!img) return;
        if (on && !img.dataset.missing) {
          img.hidden = false;
        } else {
          img.hidden = true;
          if (on && img.dataset.missing) {
            var v = vids[i];
            attachSrc(v, 'auto');
            var toEnd = function () { seekTo(v, Math.max(0, (v.duration || 0) - 0.05)); };
            if (v.readyState >= 1) toEnd();
            else v.addEventListener('loadedmetadata', toEnd, { once: true });
          }
        }
      });
    }

    function resetClips() {
      vids.forEach(function (v) {
        v.pause();
        if (v.readyState >= 1) seekTo(v, 0);
      });
    }

    function clearTimer() {
      window.clearTimeout(timer);
      timer = 0;
    }

    function schedule(ms) {
      clearTimer();
      if (!auto || !inView) return;
      var my = token;
      timer = window.setTimeout(function () {
        if (my !== token) return;
        setPhase((phase + 1) % 4, false);
      }, ms);
    }

    function flyBestToState(done) {
      var src = stateNext && stateNext.getAttribute('src');
      var from = props[bestIdx] && $('.mpc-frame', props[bestIdx]).getBoundingClientRect();
      var to = stateFrame.getBoundingClientRect();
      if (reduceMotion || !src || !from || !from.width || !Element.prototype.animate) {
        done();
        return;
      }
      var ghost = document.createElement('img');
      ghost.className = 'mpc-ghost';
      ghost.alt = '';
      ghost.src = src;
      ghost.style.left = from.left + 'px';
      ghost.style.top = from.top + 'px';
      ghost.style.width = from.width + 'px';
      ghost.style.height = from.height + 'px';
      ghost.style.transformOrigin = '0 0';
      document.body.appendChild(ghost);
      var dx = to.left - from.left;
      var dy = to.top - from.top;
      var sx = to.width / from.width;
      var sy = to.height / from.height;
      var anim = ghost.animate([
        { transform: 'translate(0px, 0px) scale(1, 1)' },
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + sx + ', ' + sy + ')' }
      ], { duration: 650, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'forwards' });
      var finished = false;
      var finish = function () {
        if (finished) return;
        finished = true;
        if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
        done();
      };
      anim.onfinish = finish;
      anim.oncancel = finish;
      window.setTimeout(finish, 1200);
    }

    function setPhase(p, userAction) {
      token += 1;
      var my = token;
      clearTimer();
      phase = p;
      root.dataset.phase = String(p);
      root.classList.remove('is-replan');
      steps.forEach(function (b) { b.setAttribute('aria-pressed', String(Number(b.dataset.phase) === p)); });
      text.textContent = TEXT[p];

      if (p === 0) {
        if (stateNext) stateNext.hidden = true;
        if (stateNow) stateNow.hidden = false;
        stateName.textContent = 'Current state';
        showLasts(false);
        resetClips();
        schedule(3000);
      } else if (p === 1) {
        if (stateNext) stateNext.hidden = true;
        if (stateNow) stateNow.hidden = false;
        stateName.textContent = 'Current state';
        showLasts(false);
        var pending = vids.length;
        var finished = function () {
          pending -= 1;
          if (pending <= 0 && my === token) {
            showLasts(true);
            schedule(700);
          }
        };
        vids.forEach(function (v) {
          attachSrc(v, 'auto');
          v.addEventListener('ended', finished, { once: true });
          seekTo(v, 0);
          if ((inView && !reduceMotion) || userAction) safePlay(v);
        });
        // Safety net in case a clip never fires "ended".
        timer = window.setTimeout(function () {
          if (my === token && auto && inView) setPhase(2, false);
        }, 9000);
      } else if (p === 2) {
        vids.forEach(function (v) { v.pause(); });
        showLasts(true);
        if (stateNext) stateNext.hidden = true;
        if (stateNow) stateNow.hidden = false;
        stateName.textContent = 'Current state';
        schedule(3400);
      } else if (p === 3) {
        vids.forEach(function (v) { v.pause(); });
        showLasts(true);
        flyBestToState(function () {
          if (my !== token) return;
          if (stateNext) stateNext.hidden = false;
          if (stateNow) stateNow.hidden = true;
          stateName.textContent = 'New state';
          window.setTimeout(function () {
            if (my === token) root.classList.add('is-replan');
          }, 500);
          schedule(3600);
        });
      }
    }

    steps.forEach(function (b) {
      b.addEventListener('click', function () {
        auto = false;
        setAutoUI();
        setPhase(Number(b.dataset.phase), true);
      });
    });

    autoBtn.addEventListener('click', function () {
      auto = !auto;
      setAutoUI();
      if (auto) setPhase((phase + 1) % 4, false);
      else clearTimer();
    });

    setAutoUI();

    if (!hasIO) {
      inView = true;
      setPhase(0, false);
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        var was = inView;
        inView = e.isIntersecting && e.intersectionRatio >= 0.3;
        if (inView && !was) {
          vids.forEach(function (v) { attachSrc(v, 'auto'); });
          setPhase(phase, false);
        } else if (!inView && was) {
          clearTimer();
          vids.forEach(function (v) { v.pause(); });
        }
      });
    }, { threshold: [0, 0.3, 0.6] });
    io.observe(root);
    setPhase(0, false);
  }

  /* ------------------------------------------------------------ BibTeX */

  function initBib() {
    var btn = $('#bibCopy');
    var pre = $('#bibText');
    if (!btn || !pre) return;
    var timer = 0;
    function bibText() {
      var lines = $$('.bl', pre);
      if (!lines.length) return pre.textContent.trim() + '\n';
      return lines.map(function (l) { return l.textContent; }).join('\n') + '\n';
    }
    function done(ok) {
      btn.textContent = ok ? 'Copied' : 'Select and copy';
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { btn.textContent = 'Copy'; }, 1800);
    }
    function fallback(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      done(ok);
    }
    btn.addEventListener('click', function () {
      var text = bibText();
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(text); });
      } else {
        fallback(text);
      }
    });
  }

  /* ------------------------------------------------------------ misc */

  function initImages() {
    $$('.pusht-strip .vframe > img').forEach(makeImageExpandable);
  }

  function initToyFallback() {
    var el = $('.ptoy[data-planner-toy]');
    if (!el) return;
    window.addEventListener('load', function () {
      window.setTimeout(function () {
        if (!el.children.length) {
          var p = document.createElement('p');
          p.className = 'ptoy-fallback';
          p.textContent = 'The interactive toy could not be loaded. The rest of the page does not depend on it.';
          el.appendChild(p);
        }
      }, 1500);
    });
  }

  /* ------------------------------------------------------------ boot */

  initEqRows();
  initNav();
  initAutoplay();
  initSyncPairs();
  initPipeline();
  var wm = initWM();
  initMPC();
  initBib();
  initImages();
  initToyFallback();
  var charts = initCharts();

  Promise.all([loadJSON('static/media.json'), loadJSON('static/charts/charts.json')]).then(function (res) {
    var media = indexBy(res[0], 'videos');
    applyMediaSizes(media);
    charts.update(indexBy(res[1], 'charts'));
    wm.setData(res[1] && res[1].wm_rot_error);
  });
})();
