/*
 * AutoBox CEP panel — Braised Tools.
 *
 * Loads AutoBox.jsx into After Effects with $.evalFile and drives it through
 * CEP's evalScript bridge, so this panel and the ScriptUI panel share the
 * same layout engine. Panel settings are kept in localStorage.
 *
 * Plain ES5: After Effects 2020 runs CEP panels on Chromium 61.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'braised.autobox.settings';
  var ANCHORS = ['Top Left', 'Top', 'Top Right', 'Left', 'Center', 'Right', 'Bottom Left', 'Bottom', 'Bottom Right'];

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
    fillColor: [27 / 255, 54 / 255, 67 / 255],
    fillOpacity: 100,
    strokeWidth: 0,
    strokeColor: [0, 166 / 255, 105 / 255],
    ignoreHidden: 1
  };

  var cep = window.__adobe_cep__;
  var settings = load();
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
        if (Array.isArray(DEFAULTS[k]) ? Array.isArray(v) && v.length === DEFAULTS[k].length : typeof v === 'number') s[k] = v;
      });
    } catch (e) {}
    return s;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {}
  }

  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  function setStatus(message, kind) {
    var el = document.getElementById('status');
    el.textContent = message || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function toCss(c) {
    return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')';
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
      setStatus('Open this panel inside After Effects: Window › Extensions › AutoBox.', 'error');
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
    setStatus('Working…');
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
  // Controls
  // ---------------------------------------------------------------------
  function set(key, value) {
    settings[key] = value;
    save();
    render();
  }

  function clampTo(input, v) {
    var min = parseFloat(input.getAttribute('min'));
    var max = parseFloat(input.getAttribute('max'));
    if (!isNaN(min)) v = Math.max(min, v);
    if (!isNaN(max)) v = Math.min(max, v);
    return v;
  }

  function render() {
    each('[data-key]', function (el) {
      var key = el.getAttribute('data-key');
      var v = settings[key];
      if (el.classList.contains('seg') || el.classList.contains('anchor')) {
        Array.prototype.forEach.call(el.querySelectorAll('button'), function (b) {
          var on = parseInt(b.getAttribute('data-value'), 10) === v;
          b.classList.toggle('on', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        });
      } else if (el.classList.contains('swatch')) {
        el.style.background = toCss(v);
      } else if (el.type === 'checkbox') {
        el.checked = v > 0;
      } else if (document.activeElement !== el) {
        el.value = String(v);
      }
    });
    document.body.classList.toggle('is-free', settings.layout === 1);
    document.getElementById('anchor-name').textContent = ANCHORS[settings.anchor - 1] || '';
  }

  function bindControls() {
    each('[data-key]', function (el) {
      var key = el.getAttribute('data-key');
      if (el.classList.contains('seg') || el.classList.contains('anchor')) {
        el.addEventListener('click', function (e) {
          var b = e.target.closest('button');
          if (b && el.contains(b)) set(key, parseInt(b.getAttribute('data-value'), 10));
        });
      } else if (el.classList.contains('swatch')) {
        el.addEventListener('click', function () { pickColor(key); });
      } else if (el.type === 'checkbox') {
        el.addEventListener('change', function () { set(key, el.checked ? 1 : 0); });
      } else if (el.tagName === 'SELECT') {
        el.addEventListener('change', function () { set(key, parseInt(el.value, 10)); });
      } else {
        el.addEventListener('change', function () {
          var v = parseFloat(el.value);
          if (isNaN(v)) {
            el.value = String(settings[key]);
            return;
          }
          v = clampTo(el, v);
          el.value = String(v);
          set(key, v);
        });
      }
    });

    // Drag a label left/right to scrub its number, like After Effects (Shift = x10).
    each('.scrub', function (label) {
      var input = document.getElementById(label.getAttribute('for'));
      if (!input) return;
      label.addEventListener('mousedown', function (e) {
        var startX = e.clientX;
        var start = parseFloat(input.value) || 0;
        function move(ev) {
          var v = clampTo(input, Math.round(start + (ev.clientX - startX) * (ev.shiftKey ? 10 : 1)));
          input.value = String(v);
          set(input.getAttribute('data-key'), v);
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });

    each('[data-action]', function (b) {
      b.addEventListener('click', function () {
        var action = b.getAttribute('data-action');
        if (action === 'reset') {
          settings = copy(DEFAULTS);
          save();
          render();
          setStatus('Settings reset.');
        } else {
          run(action);
        }
      });
    });
  }

  // Match After Effects' UI brightness.
  function applyTheme() {
    if (!cep) return;
    try {
      var env = JSON.parse(cep.getHostEnvironment());
      var c = env.appSkinInfo.panelBackgroundColor.color;
      var root = document.documentElement;
      root.style.setProperty('--bg', 'rgb(' + Math.round(c.red) + ',' + Math.round(c.green) + ',' + Math.round(c.blue) + ')');
      root.classList.toggle('light', (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) / 255 > 0.5);
    } catch (e) {}
  }

  applyTheme();
  if (cep && cep.addEventListener) {
    cep.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme);
  }
  bindControls();
  render();
  loadHost();

  window.AutoBoxPanel = {
    DEFAULTS: DEFAULTS,
    settings: function () { return settings; }
  };
})();
