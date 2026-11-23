/* Property Linker panel (CEP). Talks to jsx/property-linker.jsx through
   window.__adobe_cep__.evalScript - no CSInterface.js needed.
   Kept to ES2015 so it runs in the oldest supported CEP (9, AE CC 2019). */
(function () {
  'use strict';

  var cep = window.__adobe_cep__;
  var STORE_KEY = 'propertyLinker.settings';

  var CONTROLS = {
    opacity: 'Adds a Slider Control',
    rotation: 'Adds an Angle Control',
    scale: 'Adds a Slider Control (uniform scale)',
    position: 'Adds a Point Control (3D Point if any layer is 3D)'
  };
  var LABELS = { opacity: 'Opacity', rotation: 'Rotation', scale: 'Scale', position: 'Position' };

  var MODE_CAPTIONS = {
    absolute: {
      opacity: 'Every layer\'s Opacity is set to the slider.',
      rotation: 'Every layer\'s Rotation is set to the angle.',
      scale: 'Every layer\'s Scale is set to the slider.',
      position: 'Every layer\'s Position is set to the point.',
      selected: 'Every property is set to its control\'s value.'
    },
    relative: {
      opacity: 'Multiplies each layer\'s own Opacity. 100% = unchanged.',
      rotation: 'Adds to each layer\'s own Rotation. 0 = unchanged.',
      scale: 'Multiplies each layer\'s own Scale. 100% = unchanged.',
      position: 'Offsets each layer\'s own Position. 0, 0 = unchanged.',
      selected: 'Multiplies % values (100 = unchanged) and offsets the rest.'
    }
  };

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    property: $('property'),
    propertyCaption: $('propertyCaption'),
    modeButtons: Array.prototype.slice.call(document.querySelectorAll('.segmented button')),
    modeCaption: $('modeCaption'),
    useExisting: $('useExisting'),
    overwrite: $('overwrite'),
    link: $('link'),
    status: $('status'),
    statusMessage: $('statusMessage'),
    statusList: $('statusList'),
    version: $('version')
  };

  // ---------------------------------------------------------------- state

  var state = { choice: 'opacity', mode: 'absolute', useExisting: false, overwrite: false };

  function loadSettings() {
    try {
      var saved = JSON.parse(window.localStorage.getItem(STORE_KEY) || '{}');
      if (saved && typeof saved === 'object') {
        if (MODE_CAPTIONS.absolute[saved.choice]) state.choice = saved.choice;
        if (saved.mode === 'relative' || saved.mode === 'absolute') state.mode = saved.mode;
        state.useExisting = saved.useExisting === true;
        state.overwrite = saved.overwrite === true;
      }
    } catch (e) { /* private mode / blocked storage: keep defaults */ }
  }

  function saveSettings() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }

  function render() {
    els.property.value = state.choice;
    els.useExisting.checked = state.useExisting;
    els.overwrite.checked = state.overwrite;
    els.modeButtons.forEach(function (b) {
      b.setAttribute('aria-checked', String(b.getAttribute('data-mode') === state.mode));
    });

    var caption;
    if (state.choice === 'selected') {
      caption = 'Links the properties you select in the timeline. Each kind of property gets its own control on ' +
        (state.useExisting ? 'the selected control null.' : 'one new null.');
    } else {
      caption = CONTROLS[state.choice] + ' to ' +
        (state.useExisting ? 'the selected control null.' : 'a new "' + LABELS[state.choice] + ' Control" null.');
    }
    els.propertyCaption.textContent = caption;
    els.modeCaption.textContent = MODE_CAPTIONS[state.mode][state.choice];
  }

  function showStatus(kind, message, items) {
    els.status.hidden = false;
    els.status.className = 'status ' + kind;
    els.statusMessage.textContent = message;
    els.statusList.textContent = '';
    (items || []).forEach(function (text) {
      var li = document.createElement('li');
      li.textContent = text;
      els.statusList.appendChild(li);
    });
  }

  // ----------------------------------------------------------------- host

  function evalHost(script) {
    return new Promise(function (resolve) { cep.evalScript(script, resolve); });
  }

  function extensionFolder() {
    var path = decodeURI(cep.getSystemPath('extension'));
    // file:///C:/... on Windows, file:///Users/... on macOS
    return path.replace(/^file:\/\/\/(?=[A-Za-z]:)/, '').replace(/^file:\/\//, '');
  }

  // CEP loads jsx/property-linker.jsx via ScriptPath; load it ourselves if
  // that didn't happen (or After Effects' script engine was reset).
  function ensureHost() {
    return evalHost('typeof PropertyLinker').then(function (type) {
      if (type === 'object') return true;
      var file = extensionFolder() + '/jsx/property-linker.jsx';
      return evalHost('$.evalFile(' + JSON.stringify(file) + '); typeof PropertyLinker')
        .then(function (again) { return again === 'object'; });
    });
  }

  function link() {
    els.link.disabled = true;
    var script = 'PropertyLinker.link(' + JSON.stringify(state.choice) + ', ' +
      (state.mode === 'relative') + ', ' + state.useExisting + ', ' + state.overwrite + ')';

    ensureHost()
      .then(function (loaded) {
        if (!loaded) throw new Error('The Property Linker script didn\'t load in After Effects. Try closing and reopening the panel.');
        return evalHost(script);
      })
      .then(function (raw) {
        var result;
        try { result = JSON.parse(raw); } catch (e) {
          throw new Error('After Effects returned an unexpected response: ' + raw);
        }
        if (result.ok) {
          showStatus(result.warnings.length ? 'warn' : 'ok', result.message, result.warnings);
        } else {
          // "Nothing was linked.\n\nreason\nreason" -> heading + list
          var parts = String(result.message).split('\n\n');
          var items = parts.length > 1 ? parts.slice(1).join('\n').split('\n').filter(Boolean) : [];
          showStatus(result.userError ? 'warn' : 'error', parts[0], items);
        }
      })
      .catch(function (err) {
        showStatus('error', err.message || String(err));
      })
      .then(function () { els.link.disabled = false; });
  }

  // ---------------------------------------------------------------- theme

  // Match After Effects' interface brightness setting.
  function applyTheme() {
    try {
      var skin = JSON.parse(cep.getHostEnvironment()).appSkinInfo;
      var c = skin.panelBackgroundColor.color;
      var rgb = function (r, g, b) { return 'rgb(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ')'; };
      var shade = function (k) {
        var t = k < 0 ? 0 : 255;
        var a = Math.abs(k);
        return rgb(c.red + (t - c.red) * a, c.green + (t - c.green) * a, c.blue + (t - c.blue) * a);
      };
      var light = (0.299 * c.red + 0.587 * c.green + 0.114 * c.blue) > 140;
      var s = document.documentElement.style;
      s.setProperty('--bg', rgb(c.red, c.green, c.blue));
      s.setProperty('--field', shade(light ? 0.35 : -0.28));
      s.setProperty('--field-border', shade(light ? -0.18 : 0.14));
      s.setProperty('--field-hover', shade(light ? -0.3 : 0.22));
      s.setProperty('--text', light ? '#2b2b2b' : '#c9c9c9');
      s.setProperty('--text-strong', light ? '#111111' : '#e8e8e8');
      s.setProperty('--muted', light ? '#555555' : '#8f8f8f');
      if (skin.baseFontFamily) s.setProperty('--font', '"' + skin.baseFontFamily + '", ' + getComputedStyle(document.documentElement).getPropertyValue('--font'));
      if (skin.baseFontSize) s.setProperty('--font-size', Math.max(11, Math.min(14, skin.baseFontSize)) + 'px');
    } catch (e) { /* keep CSS defaults */ }
  }

  // ----------------------------------------------------------------- init

  els.property.addEventListener('change', function () {
    state.choice = els.property.value;
    saveSettings();
    render();
  });
  els.modeButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      state.mode = b.getAttribute('data-mode');
      saveSettings();
      render();
    });
  });
  els.useExisting.addEventListener('change', function () {
    state.useExisting = els.useExisting.checked;
    saveSettings();
    render();
  });
  els.overwrite.addEventListener('change', function () {
    state.overwrite = els.overwrite.checked;
    saveSettings();
  });
  els.link.addEventListener('click', link);

  loadSettings();
  render();

  if (!cep) {
    els.link.disabled = true;
    showStatus('warn', 'Open this panel inside After Effects: Window > Extensions > Property Linker.');
    return;
  }

  applyTheme();
  cep.addEventListener('com.adobe.csxs.events.ThemeColorChanged', applyTheme);
  ensureHost().then(function (loaded) {
    if (!loaded) {
      showStatus('error', 'The Property Linker script didn\'t load in After Effects. Try closing and reopening the panel.');
      return;
    }
    return evalHost('PropertyLinker.version').then(function (v) {
      els.version.textContent = 'Property Linker v' + v + ' \u00b7 Braised Animation';
    });
  });
})();
