/*
 * AutoBox CEP panel — Braised Tools.
 *
 * Loads AutoBox.jsx into After Effects with $.evalFile and drives it through
 * CEP's evalScript bridge, so this panel and the ScriptUI panel share the
 * same engine. Settings and twirl states are kept in localStorage.
 *
 * Controls follow After Effects: blue "hot text" numbers you drag left/right
 * (Shift = x10, Ctrl/Cmd = x0.1) or click to type, sliders you twirl open,
 * angle dials, color swatches and two-stop gradient bars.
 *
 * Plain ES5: After Effects 2020 runs CEP panels on Chromium 61.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'braised.autobox.settings';
  var TWIRL_KEY = 'braised.autobox.twirls';
  var ANCHORS = ['Top Left', 'Top', 'Top Right', 'Left', 'Center', 'Right', 'Bottom Left', 'Bottom', 'Bottom Right'];
  var DRAG_THRESHOLD = 3;

  // Keep in sync with DEFAULTS in AutoBox.jsx (checked by the test suite).
  var DEFAULTS = {
    layout: 1,
    gap: 16,
    align: 1,
    justify: 1,
    anchor: 1,
    padding: 32,
    extraTop: 0,
    extraRight: 0,
    extraBottom: 0,
    extraLeft: 0,
    radius: 16,
    minWidth: 0,
    minHeight: 0,
    fillType: 1,
    fillColor: [27 / 255, 54 / 255, 67 / 255],
    fillColor2: [0, 166 / 255, 105 / 255],
    fillAngle: 90,
    fillOpacity: 100,
    strokeType: 1,
    strokeColor: [0, 166 / 255, 105 / 255],
    strokeColor2: [1, 1, 1],
    strokeAngle: 90,
    strokeWidth: 0,
    strokeOpacity: 100,
    ignoreHidden: 1
  };

  // Which settings each section's Reset restores.
  var GROUPS = {
    layout: ['layout', 'gap', 'align', 'justify', 'anchor'],
    box: ['padding', 'extraTop', 'extraRight', 'extraBottom', 'extraLeft', 'radius', 'minWidth', 'minHeight', 'ignoreHidden'],
    fill: ['fillType', 'fillColor', 'fillColor2', 'fillAngle', 'fillOpacity'],
    stroke: ['strokeType', 'strokeColor', 'strokeColor2', 'strokeAngle', 'strokeWidth', 'strokeOpacity']
  };

  var cep = window.__adobe_cep__;
  var settings = load();
  var twirls = loadTwirls();
  var hostReady = false;
  var busy = false;

  function copy(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function load() {
    var s = copy(DEFAULTS);
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
      Object.keys(DEFAULTS).forEach(function (k) {
        var v = saved[k];
        var ok = Array.isArray(DEFAULTS[k]) ?
          Array.isArray(v) && v.length === DEFAULTS[k].length && v.every(isFinite) :
          typeof v === 'number' && isFinite(v);
        if (ok) s[k] = v;
      });
    } catch (e) {}
    return s;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  function loadTwirls() {
    try {
      return JSON.parse(window.localStorage.getItem(TWIRL_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function saveTwirls() {
    try {
      window.localStorage.setItem(TWIRL_KEY, JSON.stringify(twirls));
    } catch (e) {}
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function each(selector, fn, root) {
    Array.prototype.forEach.call((root || document).querySelectorAll(selector), fn);
  }

  function setStatus(message, kind) {
    var el = $('#status');
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function toCss(c) {
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
  }

  function num(el, attr, fallback) {
    var v = parseFloat(el.getAttribute(attr));
    return isNaN(v) ? fallback : v;
  }

  function clampFor(el, v) {
    return Math.min(num(el, 'data-max', Infinity), Math.max(num(el, 'data-min', -Infinity), v));
  }

  function round(v, decimals) {
    var f = Math.pow(10, decimals);
    return Math.round(v * f) / f;
  }

  // After Effects shows angles as revolutions + degrees: "0x+90.0°".
  function formatAngle(v) {
    var turns = v < 0 ? Math.ceil(v / 360) : Math.floor(v / 360);
    var deg = v - turns * 360;
    return turns + 'x' + (deg < 0 ? '' : '+') + deg.toFixed(1) + '\u00b0';
  }

  function formatValue(el, v) {
    if (el.getAttribute('data-format') === 'angle') return formatAngle(v);
    return String(round(v, num(el, 'data-decimals', 0)));
  }

  // ---------------------------------------------------------------------
  // Host bridge
  // ---------------------------------------------------------------------
  function evalHost(script, done) {
    if (!cep) {
      done('EvalScript error.');
      return;
    }
    cep.evalScript(script, function (result) {
      done(result === undefined || result === null ? '' : String(result));
    });
  }

  function extensionPath() {
    var p = decodeURI(cep.getSystemPath('extension'));
    // file:///C:/... on Windows, file:///Library/... on macOS
    p = p.replace(/^file:\/\/\/(?=[A-Za-z]:)/, '').replace(/^file:\/\//, '');
    return p.replace(/\\/g, '/');
  }

  function loadHost(done) {
    if (!cep) {
      setStatus('Open this panel inside After Effects: Window \u203a Extensions \u203a AutoBox.', 'error');
      return;
    }
    var file = extensionPath() + '/jsx/AutoBox.jsx';
    var script = '(function () {' +
      '$.global.AUTOBOX_CEP = true;' +
      'try { $.evalFile(' + JSON.stringify(file) + '); } finally { $.global.AUTOBOX_CEP = undefined; }' +
      'return (typeof $.global.AutoBoxHost === "object") ? $.global.AutoBoxHost.version : "missing";' +
      '})()';
    evalHost(script, function (result) {
      hostReady = /^\d+\.\d+/.test(result);
      if (hostReady) {
        setStatus('');
        if (done) done();
      } else {
        setStatus('Could not load the AutoBox script into After Effects (' + result + ').', 'error');
      }
    });
  }

  function run(action) {
    if (busy) return;
    if (!hostReady) {
      loadHost(function () { run(action); });
      return;
    }
    busy = true;
    setStatus('Working\u2026');
    evalHost('$.global.AutoBoxHost.run(' + JSON.stringify(action) + ', ' + JSON.stringify(settings) + ')', function (result) {
      busy = false;
      if (result === 'ok') setStatus('');
      else setStatus(result || 'After Effects did not respond.', 'error');
    });
  }

  function pickColor(key) {
    var c = settings[key];
    var hex = (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
    evalHost('$.colorPicker(' + hex + ')', function (result) {
      var n = parseInt(result, 10);
      if (isNaN(n) || n < 0) return;
      set(key, [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]);
    });
  }

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------
  function set(key, value) {
    settings[key] = value;
    save();
    render();
  }

  function setMany(values) {
    Object.keys(values).forEach(function (k) { settings[k] = values[k]; });
    save();
    render();
  }

  // Element visibility: data-show="fillType:2,3" shows it only for those values.
  function shown(el) {
    var rule = el.getAttribute('data-show');
    if (!rule) return true;
    var parts = rule.split(':');
    return parts[1].split(',').map(Number).indexOf(settings[parts[0]]) >= 0;
  }

  function render() {
    each('[data-show]', function (el) {
      el.hidden = !shown(el);
    });
    each('.hot[data-key]', function (el) {
      if (el.classList.contains('editing')) return;
      el.textContent = formatValue(el, settings[el.getAttribute('data-key')]);
      el.setAttribute('aria-valuenow', String(settings[el.getAttribute('data-key')]));
    });
    each('.slider[data-key]', function (el) {
      var v = settings[el.getAttribute('data-key')];
      var lo = num(el, 'data-smin', 0), hi = num(el, 'data-smax', 100);
      var f = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
      $('.thumb', el).style.left = (f * 100) + '%';
      $('.fill', el).style.width = (f * 100) + '%';
    });
    each('.dial[data-key]', function (el) {
      // 0° points up and angles turn clockwise, like After Effects.
      $('.hand', el).style.transform = 'rotate(' + settings[el.getAttribute('data-key')] + 'deg)';
    });
    each('.seg[data-key], .anchor[data-key]', function (el) {
      var v = settings[el.getAttribute('data-key')];
      each('button', function (b) {
        var on = parseInt(b.getAttribute('data-value'), 10) === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
      }, el);
    });
    each('select[data-key]', function (el) {
      el.value = String(settings[el.getAttribute('data-key')]);
    });
    each('.swatch[data-key]', function (el) {
      el.style.backgroundColor = toCss(settings[el.getAttribute('data-key')]);
    });
    each('.gradient[data-from]', function (el) {
      var a = toCss(settings[el.getAttribute('data-from')]);
      var b = toCss(settings[el.getAttribute('data-to')]);
      var radial = settings[el.getAttribute('data-type')] === 3;
      $('.ramp', el).style.backgroundImage = radial ?
        'radial-gradient(circle at 0 50%, ' + a + ', ' + b + ')' :
        'linear-gradient(to right, ' + a + ', ' + b + ')';
    });
    each('input[type="checkbox"][data-key]', function (el) {
      el.checked = settings[el.getAttribute('data-key')] > 0;
    });
    each('[data-twirl]', function (el) {
      var open = twirls[el.getAttribute('data-twirl')];
      if (open === undefined) open = el.getAttribute('data-open') !== 'false';
      el.classList.toggle('open', open);
      var t = $('.twirl', el);
      if (t) t.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.body.classList.toggle('is-free', settings.layout === 1);
    document.body.classList.toggle('is-horizontal', settings.layout === 3);
    $('#layout-name').textContent = ['Free', 'Vertical', 'Horizontal'][settings.layout - 1] || '';
    $('#anchor-name').textContent = ANCHORS[settings.anchor - 1] || '';
  }

  // Not inside something hidden or a closed twirl-down.
  function isVisible(el) {
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (p.hidden) return false;
      if (p.classList.contains('body') && p.parentElement.hasAttribute('data-twirl') &&
          !p.parentElement.classList.contains('open')) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // Hot text: drag to scrub, click to type, arrows to nudge
  // ---------------------------------------------------------------------
  function scrubMultiplier(e) {
    if (e.shiftKey) return 10;
    if (e.ctrlKey || e.metaKey) return 0.1;
    return 1;
  }

  function commitHot(el, v) {
    var r = round(clampFor(el, v), num(el, 'data-decimals', 0));
    if (!isFinite(r)) {
      render();
      return;
    }
    set(el.getAttribute('data-key'), r);
  }

  // Track a drag on the document. onMove gets every mousemove; onEnd gets
  // true for a real mouseup, false if the button was released somewhere the
  // panel couldn't see (outside it, or the window lost focus).
  function track(onMove, onEnd) {
    // On macOS, a move processed after a quick click can already report no
    // buttons: only treat that as a lost release once a pressed move was seen.
    var pressed = false;
    function move(ev) {
      if (ev.buttons) {
        pressed = true;
      } else {
        end(!pressed);
        return;
      }
      onMove(ev);
    }
    function up() { end(true); }
    function lost() { end(false); }
    function end(released) {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      window.removeEventListener('blur', lost);
      onEnd(released);
    }
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    window.addEventListener('blur', lost);
  }

  function bindHot(el) {
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || el.classList.contains('editing')) return;
      e.preventDefault();
      var key = el.getAttribute('data-key');
      var step = num(el, 'data-step', 1);
      var lastX = e.clientX, travel = 0, value = settings[key], dragging = false;
      // Modifiers scale only the movement since the last event, so pressing
      // Shift or Ctrl/Cmd mid-drag never makes the value jump, and the value
      // turns around as soon as the drag does, even after hitting a limit.
      track(function (ev) {
        var d = ev.clientX - lastX;
        lastX = ev.clientX;
        if (!dragging) {
          travel += d;
          if (Math.abs(travel) < DRAG_THRESHOLD) return;
          dragging = true;
          document.body.classList.add('scrubbing');
          d = travel - (travel > 0 ? DRAG_THRESHOLD : -DRAG_THRESHOLD);
        }
        value = clampFor(el, value + d * step * scrubMultiplier(ev));
        commitHot(el, value);
      }, function (released) {
        document.body.classList.remove('scrubbing');
        if (!dragging && released) startEdit(el);
      });
    });
    el.addEventListener('keydown', function (e) {
      var key = el.getAttribute('data-key');
      var step = num(el, 'data-step', 1) * scrubMultiplier(e);
      if (e.key === 'Enter') {
        e.preventDefault();
        startEdit(el);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
        e.preventDefault();
        commitHot(el, settings[key] + step);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
        e.preventDefault();
        commitHot(el, settings[key] - step);
      }
    });
  }

  function startEdit(el) {
    var key = el.getAttribute('data-key');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'hot-edit';
    input.value = String(round(settings[key], 3));
    input.setAttribute('aria-label', el.getAttribute('aria-label') || key);
    el.classList.add('editing');
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function finish(commit, moveBy) {
      if (done) return;
      done = true;
      var v = parseFloat(input.value);
      el.classList.remove('editing');
      if (input.parentNode) el.removeChild(input);
      if (commit && isFinite(v)) commitHot(el, v);
      else render();
      if (moveBy) {
        var all = Array.prototype.filter.call(document.querySelectorAll('.hot[data-key]'), function (h) {
          return h === el || isVisible(h);
        });
        var next = all[(all.indexOf(el) + moveBy + all.length) % all.length];
        if (next) startEdit(next);
      } else {
        el.focus();
      }
    }
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, e.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', function () { finish(true); });
    input.addEventListener('mousedown', function (e) { e.stopPropagation(); });
  }

  // ---------------------------------------------------------------------
  // Sliders and dials
  // ---------------------------------------------------------------------
  function bindDrag(el, onPoint) {
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      onPoint(e);
      track(onPoint, function () {});
    });
  }

  function bindSlider(el) {
    var key = el.getAttribute('data-key');
    var hot = $('.hot[data-key="' + key + '"]');
    bindDrag(el, function (e) {
      var rect = $('.track', el).getBoundingClientRect();
      var f = rect.width ? Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) : 0;
      var lo = num(el, 'data-smin', 0), hi = num(el, 'data-smax', 100);
      var v = lo + f * (hi - lo);
      set(key, round(hot ? clampFor(hot, v) : v, num(hot || el, 'data-decimals', 0)));
    });
  }

  function bindDial(el) {
    var key = el.getAttribute('data-key');
    bindDrag(el, function (e) {
      var rect = el.getBoundingClientRect();
      var dx = e.clientX - (rect.left + rect.width / 2), dy = e.clientY - (rect.top + rect.height / 2);
      if (!dx && !dy) return;
      var deg = Math.atan2(dx, -dy) * 180 / Math.PI;
      var turns = Math.floor(settings[key] / 360);
      set(key, round(turns * 360 + ((deg % 360) + 360) % 360, 1));
    });
  }

  // ---------------------------------------------------------------------
  // Everything else
  // ---------------------------------------------------------------------
  function bindControls() {
    each('.hot[data-key]', bindHot);
    each('.slider[data-key]', bindSlider);
    each('.dial[data-key]', bindDial);

    each('.seg[data-key], .anchor[data-key]', function (el) {
      var key = el.getAttribute('data-key');
      el.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (b && el.contains(b)) set(key, parseInt(b.getAttribute('data-value'), 10));
      });
    });
    each('select[data-key]', function (el) {
      el.addEventListener('change', function () {
        set(el.getAttribute('data-key'), parseInt(el.value, 10));
        // After a mouse pick, hand the keyboard back to After Effects (a
        // focused menu keeps it); keyboard users keep stepping through it.
        if (document.body.classList.contains('pointer')) el.blur();
      });
    });
    each('input[type="checkbox"][data-key]', function (el) {
      el.addEventListener('change', function () { set(el.getAttribute('data-key'), el.checked ? 1 : 0); });
    });
    each('[data-pick]', function (el) {
      el.addEventListener('click', function () { pickColor(el.getAttribute('data-pick')); });
    });
    each('[data-swap]', function (el) {
      el.addEventListener('click', function () {
        var keys = el.getAttribute('data-swap').split(','), values = {};
        values[keys[0]] = settings[keys[1]];
        values[keys[1]] = settings[keys[0]];
        setMany(values);
      });
    });
    each('[data-twirl] > .twirl, [data-twirl] > .head', function (el) {
      function toggle() {
        var box = el.parentElement;
        twirls[box.getAttribute('data-twirl')] = !box.classList.contains('open');
        saveTwirls();
        render();
      }
      el.addEventListener('click', function (e) {
        if (e.target.closest('.reset')) return;
        toggle();
      });
      el.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === el) {
          e.preventDefault();
          toggle();
        }
      });
    });
    each('.reset[data-group]', function (el) {
      function reset(e) {
        e.stopPropagation();
        var values = {};
        GROUPS[el.getAttribute('data-group')].forEach(function (k) { values[k] = copy(DEFAULTS[k]); });
        setMany(values);
      }
      el.addEventListener('click', reset);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          reset(e);
        }
      });
    });
    each('[data-action]', function (b) {
      b.addEventListener('click', function () { run(b.getAttribute('data-action')); });
    });
  }

  // ---------------------------------------------------------------------
  // Keyboard: CEP sends keys to After Effects unless a text field has focus.
  // While a value, section header or Reset link has focus, ask for the few
  // keys the panel uses; everything else (Space to preview...) stays with AE.
  // ---------------------------------------------------------------------
  var KEY_CODES = /Mac/.test(navigator.platform) ?
    { Enter: [36, 76], Space: [49], Tab: [48], Left: [123], Right: [124], Down: [125], Up: [126] } :
    { Enter: [13], Space: [32], Tab: [9], Left: [37], Up: [38], Right: [39], Down: [40] };

  function keyInterest(names) {
    var list = [];
    names.forEach(function (n) {
      KEY_CODES[n].forEach(function (code) {
        list.push({ keyCode: code }, { keyCode: code, shiftKey: true }, { keyCode: code, ctrlKey: true }, { keyCode: code, metaKey: true });
      });
    });
    return JSON.stringify(list);
  }

  function bindKeyboard() {
    if (cep && cep.registerKeyEventsInterest) {
      // Space and Enter only for keyboard users: after a mouse click the
      // clicked control keeps focus, and Space must still reach AE (preview).
      document.addEventListener('focusin', function (e) {
        var t = e.target, names = null, keyboard = !document.body.classList.contains('pointer');
        if (t.classList && t.classList.contains('hot')) names = ['Enter', 'Tab', 'Left', 'Right', 'Up', 'Down'];
        else if (t.matches && t.matches('.fx > .head, .reset, .twirl')) names = keyboard ? ['Enter', 'Space', 'Tab'] : ['Tab'];
        else if (t.matches && t.matches('button, input[type="checkbox"]')) names = ['Tab'];
        cep.registerKeyEventsInterest(names ? keyInterest(names) : '');
      });
      document.addEventListener('focusout', function () { cep.registerKeyEventsInterest(''); });
    }
    // Focus rings only for keyboard users (Chromium 61 has no :focus-visible).
    document.addEventListener('mousedown', function () { document.body.classList.add('pointer'); }, true);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Tab') document.body.classList.remove('pointer');
    }, true);
  }

  // ---------------------------------------------------------------------
  // Theme: follow After Effects' Brightness setting. Colors are derived from
  // the panel background so contrast holds from darkest to lightest.
  // ---------------------------------------------------------------------
  function shade(c, d) {
    function ch(v) { return Math.max(0, Math.min(255, Math.round(v + d))); }
    return 'rgb(' + ch(c.r) + ',' + ch(c.g) + ',' + ch(c.b) + ')';
  }

  function luminance(c) {
    function lin(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  // Blend `base` toward white (lighten) or black until it reaches 3:1
  // against every background in `against`.
  function readable(base, against, lighten) {
    for (var f = 0; f <= 1.0001; f += 0.05) {
      var c = base.map(function (v) { return Math.round(lighten ? v + (255 - v) * f : v * (1 - f)); });
      if (against.every(function (bg) { return contrast(c, bg) >= 3; })) return c;
    }
    return lighten ? [255, 255, 255] : [0, 0, 0];
  }

  function rgb(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

  function applyTheme() {
    if (!cep) return;
    try {
      var skin = JSON.parse(cep.getHostEnvironment()).appSkinInfo;
      var c = skin.panelBackgroundColor.color, bg = { r: c.red, g: c.green, b: c.blue };
      var lum = (0.299 * bg.r + 0.587 * bg.g + 0.114 * bg.b) / 255;
      var root = document.documentElement, light = lum > 0.47;
      var put = function (k, v) { root.style.setProperty(k, v); };
      root.classList.toggle('light', light);
      put('--bg', shade(bg, 0));
      var g = function (d) { return [bg.r, bg.g, bg.b].map(function (v) { return Math.max(0, Math.min(255, Math.round(v + d))); }); };
      var surfaces = light ? [g(0), g(-16)] : [g(0), g(19)];
      var hot = readable(light ? [13, 93, 196] : [94, 170, 247], surfaces, !light);
      if (light) {
        put('--head-bg', shade(bg, -16));
        put('--line', shade(bg, -48));
        put('--field', shade(bg, 30));
        put('--well-border', shade(bg, -90));
        put('--control', shade(bg, -14));
        put('--control-hover', shade(bg, -4));
        put('--control-border', shade(bg, -70));
        put('--muted', shade(bg, -95));
        put('--twirl', shade(bg, -110));
        put('--text', '#1b1b1b');
        put('--hot', rgb(hot));
        put('--hot-hover', rgb(readable(hot.map(function (v) { return Math.round(v * 0.75); }), surfaces, false)));
      } else {
        var mid = lum > 0.3;
        put('--head-bg', shade(bg, 19));
        put('--line', shade(bg, -15));
        put('--field', shade(bg, -15));
        put('--well-border', shade(bg, 112));
        put('--control', shade(bg, 30));
        put('--control-hover', shade(bg, 42));
        put('--control-border', shade(bg, 60));
        put('--muted', shade(bg, mid ? 120 : 95));
        put('--twirl', shade(bg, 120));
        put('--text', mid ? '#ffffff' : '#ebebeb');
        put('--hot', rgb(hot));
        put('--hot-hover', rgb(readable(hot.map(function (v) { return Math.round(v + (255 - v) * 0.3); }), surfaces, true)));
      }
      if (skin.baseFontFamily && !/^\./.test(skin.baseFontFamily)) {
        put('--font', '"' + skin.baseFontFamily + '", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif');
      }
      if (skin.baseFontSize) put('--font-size', skin.baseFontSize + 'px');
    } catch (e) {}
  }

  applyTheme();
  if (cep && cep.addEventListener) {
    cep.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme);
  }
  bindControls();
  bindKeyboard();
  render();
  loadHost();

  window.AutoBoxPanel = {
    DEFAULTS: DEFAULTS,
    settings: function () { return settings; }
  };
})();
