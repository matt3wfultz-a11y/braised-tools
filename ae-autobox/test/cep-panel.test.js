'use strict';

// Drives the CEP panel (cep/index.html + panel.js) in jsdom. Its evalScript
// calls run against the After Effects mock with the real AutoBox.jsx loaded
// through $.evalFile, the same way the installed extension works.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const acorn = require('acorn');
const { JSDOM } = require('jsdom');
const { createHost, Prop, SCRIPT_PATH } = require('./ae-mock');
const { stageExtension } = require('../scripts/build-zxp');

const ROOT = path.join(__dirname, '..');
const CEP = path.join(ROOT, 'cep');
const PANEL_JS = fs.readFileSync(path.join(CEP, 'js', 'panel.js'), 'utf8');
const HTML = fs.readFileSync(path.join(CEP, 'index.html'), 'utf8');
const EXT_DIR = stageExtension(fs.mkdtempSync(path.join(os.tmpdir(), 'autobox ext ')));

const tick = () => new Promise((r) => setImmediate(r));

function near(actual, expected, msg) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, msg);
    expected.forEach((e, i) => near(actual[i], e, `${msg || ''}[${i}]`));
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-6, `${msg || 'value'}: expected ${expected}, got ${actual}`);
}

function fakeCep() {
  return {
    calls: [],
    keyInterest: [],
    fail: false,
    registerKeyEventsInterest(json) { this.keyInterest.push(json); },
    getSystemPath: () => 'file://' + encodeURI(EXT_DIR),
    getHostEnvironment: () => JSON.stringify({ appSkinInfo: { panelBackgroundColor: { color: { red: 35, green: 35, blue: 35 } } } }),
    addEventListener() {},
    evalScript(script, cb) {
      this.calls.push(script);
      setImmediate(() => {
        let r;
        try {
          if (this.fail) throw new Error('host failure');
          r = vm.runInThisContext(script);
        } catch (e) {
          r = 'EvalScript error.';
        }
        cb(r === undefined ? 'undefined' : String(r));
      });
    },
  };
}

async function openPanel(host, { cep = fakeCep(), storage, twirls } = {}) {
  globalThis.$.global = globalThis;
  globalThis.$.evalFile = (p) => vm.runInThisContext(fs.readFileSync(String(p), 'utf8'), { filename: String(p) });
  delete globalThis.AutoBoxHost;
  const dom = new JSDOM(HTML, { url: 'https://autobox.test/', runScripts: 'outside-only' });
  const w = dom.window;
  if (storage) w.localStorage.setItem('braised.autobox.settings', JSON.stringify(storage));
  if (twirls) w.localStorage.setItem('braised.autobox.twirls', JSON.stringify(twirls));
  if (cep) w.__adobe_cep__ = cep;
  w.eval(PANEL_JS);
  await tick();
  await tick();
  const $ = (sel) => w.document.querySelector(sel);
  // A drag holds the left button (buttons = 1) until mouseup.
  const mouse = (type, x, y, mods = {}) => new w.MouseEvent(type, Object.assign({
    bubbles: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, clientX: x, clientY: y || 0,
  }, mods));
  const p = {
    w, cep, $,
    settings: () => w.AutoBoxPanel.settings(),
    status: () => $('#status'),
    async click(sel) {
      $(sel).click();
      await tick();
      await tick();
    },
    // Pick a menu item with the keyboard (the menu keeps focus).
    choose(sel, value) {
      const el = $(sel);
      el.value = String(value);
      el.dispatchEvent(new w.Event('change'));
    },
    // Click a hot-text value (no drag) and type into the field that opens.
    type(key, value, finishKey = 'Enter') {
      const hot = $(`.hot[data-key="${key}"]`);
      hot.dispatchEvent(mouse('mousedown', 10));
      w.document.dispatchEvent(mouse('mouseup', 10));
      const input = hot.querySelector('input');
      assert.ok(input, `${key} opens a text field`);
      input.value = String(value);
      input.dispatchEvent(new w.KeyboardEvent('keydown', { key: finishKey, bubbles: true }));
      return input;
    },
    scrub(key, moves, mods) {
      const hot = $(`.hot[data-key="${key}"]`);
      hot.dispatchEvent(mouse('mousedown', 100));
      moves.forEach((x) => w.document.dispatchEvent(mouse('mousemove', x, 0, mods)));
      w.document.dispatchEvent(mouse('mouseup', moves[moves.length - 1]));
    },
    rect(el, r) {
      el.getBoundingClientRect = () => Object.assign({ left: 0, top: 0, width: 0, height: 0 }, r);
    },
    mouse,
  };
  return p;
}

// A shape item in the box's AutoBox group: its switch and its values.
function paint(box, name) {
  const group = box.contentsState.children.find((c) => c.name === 'AutoBox');
  const item = group.children.find((c) => c.matchName === 'ADBE Vectors Group').children.find((c) => c.name === name);
  assert.ok(item, `${box.name} has ${name}`);
  return { enabled: item.enabled, value: (mn) => new Prop(item.children.find((c) => c.matchName === mn)).value };
}

function sizeExpression(box) {
  const group = box.contentsState.children.find((c) => c.name === 'AutoBox');
  const rect = group.children.find((c) => c.matchName === 'ADBE Vectors Group').children.find((c) => c.matchName === 'ADBE Vector Shape - Rect');
  return rect.children[0].expression;
}

function hasEffect(layer, name) {
  return layer.effectsState.children.some((c) => c.name === name);
}

function scene(host) {
  const comp = host.newComp();
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  return { comp, title, sub };
}

// Minimal zip reader: [{ name, data }] in archive order.
function readZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    out.push({ name, method, data: method === 0 ? raw : zlib.inflateRawSync(raw) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('panel.js is ES5 for the Chromium in After Effects 2020', () => {
  acorn.parse(PANEL_JS, { ecmaVersion: 5 });
});

test('versions and defaults agree across the script, panel and manifest', () => {
  const host = createHost();
  const version = require('../package.json').version;
  const manifest = fs.readFileSync(path.join(CEP, 'CSXS', 'manifest.xml'), 'utf8');
  const doc = new JSDOM('').window;
  const xml = new doc.DOMParser().parseFromString(manifest, 'text/xml');
  assert.equal(xml.getElementsByTagName('parsererror').length, 0, 'manifest is well-formed XML');
  const root = xml.documentElement;
  assert.equal(root.getAttribute('ExtensionBundleVersion'), version);
  assert.equal(xml.getElementsByTagName('Extension')[0].getAttribute('Version'), version);
  assert.match(fs.readFileSync(SCRIPT_PATH, 'utf8'), new RegExp(`var VERSION = "${version.replace(/\./g, '\\.')}";`));
  assert.match(HTML, new RegExp(`<span id="version">${version.replace(/\./g, '\\.')}</span>`));
  const panel = new JSDOM(HTML, { runScripts: 'outside-only' }).window;
  panel.eval(PANEL_JS);
  assert.deepEqual(JSON.parse(JSON.stringify(panel.AutoBoxPanel.DEFAULTS)), JSON.parse(JSON.stringify(host.api.DEFAULTS)));
});

test('the panel loads AutoBox.jsx into After Effects and creates a box', async () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const p = await openPanel(host);
  assert.equal(p.status().textContent, '');
  assert.match(p.cep.calls[0], /\$\.evalFile\(".*\/jsx\/AutoBox\.jsx"\)/);
  assert.equal(typeof globalThis.AutoBoxHost, 'object');
  assert.equal(globalThis.AUTOBOX_CEP, undefined, 'load flag is cleared');

  p.type('padding', 20);
  assert.equal(p.$('.hot[data-key="padding"]').textContent, '20');
  p.type('radius', -5);
  assert.equal(p.$('.hot[data-key="radius"]').textContent, '0', 'min is enforced');
  assert.ok(p.$('.fx[data-twirl="g-box"] .anchor'), 'Box Anchor is in the Box section');
  await p.click('.anchor button[data-value="5"]');
  assert.ok(p.$('.anchor button[data-value="5"]').classList.contains('on'));
  assert.equal(p.$('#anchor-name').textContent, 'Center');

  comp.select(title, sub);
  await p.click('[data-action="create"]');
  assert.deepEqual(host.alerts, []);
  assert.equal(p.status().textContent, '');
  const box = comp.layer('AutoBox 1');
  assert.equal(box.effectValue('Padding'), 20);
  assert.equal(box.effectValue('Box Anchor'), 5);
  assert.equal(box.boxRect().roundness, 0);
  near(paint(box, 'Fill').value('ADBE Vector Fill Color'), [27 / 255, 54 / 255, 67 / 255, 1], 'the starting look is native');
  assert.equal(title.parent, box);
  assert.equal(sub.parent, box);
  assert.equal(title.tprop('ADBE Position').expression, '', 'the layers get no expressions');

  const saved = JSON.parse(p.w.localStorage.getItem('braised.autobox.settings'));
  assert.equal(saved.padding, 20);
  assert.equal(saved.anchor, 5);
});

test('hot text: drag to scrub (Shift x10, Ctrl/Cmd x0.1), arrows to nudge, Escape cancels, Tab moves on', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  const v = (k) => p.settings()[k];
  p.scrub('extraTop', [101, 102, 113]);
  assert.equal(v('extraTop'), 10, 'starts after a 3px dead zone, then 1 per pixel');
  p.scrub('extraTop', [110], { shiftKey: true });
  assert.equal(v('extraTop'), 80);
  p.scrub('extraTop', [70], { ctrlKey: true });
  assert.equal(v('extraTop'), 77);
  p.scrub('extraTop', [0]);
  assert.equal(v('extraTop'), -20, 'extra padding may go negative');
  p.scrub('radius', [0]);
  assert.equal(v('radius'), 0, 'radius stops at 0');
  assert.ok(!p.w.document.body.classList.contains('scrubbing'));

  const hot = p.$('.hot[data-key="padding"]');
  hot.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(v('padding'), 33);
  hot.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
  assert.equal(v('padding'), 23);

  p.type('padding', 99, 'Escape');
  assert.equal(v('padding'), 23, 'Escape cancels');
  assert.equal(hot.textContent, '23');
  p.type('padding', 40, 'Tab');
  assert.equal(v('padding'), 40);
  assert.ok(p.$('.hot[data-key="radius"] input'), 'Tab opens the next visible value');
  assert.equal(p.$('.hot[data-key="extraTop"] input'), null);
});

test('sliders, angle dials and twirl-downs', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  const slider = p.$('.slider[data-key="padding"]');
  p.rect(slider.querySelector('.track'), { left: 0, width: 200 });
  slider.dispatchEvent(p.mouse('mousedown', 50));
  p.w.document.dispatchEvent(p.mouse('mousemove', 100));
  p.w.document.dispatchEvent(p.mouse('mouseup', 100));
  assert.equal(p.settings().padding, 100);
  assert.equal(slider.querySelector('.thumb').style.left, '50%');
  assert.equal(p.$('.hot[data-key="padding"]').textContent, '100');

  p.choose('#fill-type', 2);
  const dial = p.$('.dial[data-key="fillAngle"]');
  p.rect(dial, { left: 0, top: 0, width: 20, height: 20 });
  dial.dispatchEvent(p.mouse('mousedown', 10, 20));
  p.w.document.dispatchEvent(p.mouse('mouseup', 10, 20));
  assert.equal(p.settings().fillAngle, 180, 'pointing down is 180 degrees');
  assert.equal(p.$('.hot[data-key="fillAngle"]').textContent, '0x+180.0\u00b0');
  assert.equal(dial.querySelector('.hand').style.transform, 'rotate(180deg)');
  p.type('fillAngle', 450);
  assert.equal(p.$('.hot[data-key="fillAngle"]').textContent, '1x+90.0\u00b0');

  const row = p.$('.prop[data-twirl="s-morphTime"]');
  assert.ok(!row.classList.contains('open'), 'Morph Time slider starts closed');
  await p.click('.prop[data-twirl="s-morphTime"] > .twirl');
  assert.ok(row.classList.contains('open'));
  assert.equal(JSON.parse(p.w.localStorage.getItem('braised.autobox.twirls'))['s-morphTime'], true);
  await p.click('.fx[data-twirl="g-animation"] > .head');
  assert.ok(!p.$('.fx[data-twirl="g-animation"]').classList.contains('open'), 'sections collapse');
});

test('fill and stroke show a color swatch for solids and a note for gradients', async () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const p = await openPanel(host);
  assert.equal(p.$('[data-key="fillColor2"], [data-key="strokeColor2"], .gradient, [data-swap]'), null,
    'scripts cannot set gradient colors, so the panel has none');
  ['fill', 'stroke'].forEach((kind) => {
    const solidRow = p.$(`.swatch[data-pick="${kind}Color"]`).closest('.prop');
    const noteRow = p.$(`.prop[data-show="${kind}Type:2,3"]`);
    const angleRow = p.$(`.dial[data-key="${kind}Angle"]`).closest('.prop');
    assert.equal(noteRow.textContent.trim(), 'Gradient colors: use Edit Gradient in the box\'s Contents.');
    assert.ok(!solidRow.hidden && noteRow.hidden && angleRow.hidden, `${kind}: Solid shows the swatch`);
    p.choose(`#${kind}-type`, 3);
    assert.ok(solidRow.hidden && !noteRow.hidden && angleRow.hidden, `${kind}: radial gradients show the note, no angle`);
    p.choose(`#${kind}-type`, 2);
    assert.ok(solidRow.hidden && !noteRow.hidden && !angleRow.hidden, `${kind}: linear gradients have an angle`);
  });

  // The box starts with its gradients switched on instead of the solids.
  p.choose('#fill-type', 3);
  p.type('strokeWidth', 4);
  comp.select(title);
  await p.click('[data-action="create"]');
  assert.deepEqual(host.alerts, []);
  const box = comp.layer('AutoBox 1');
  assert.ok(!paint(box, 'Fill').enabled && paint(box, 'Gradient Fill').enabled);
  assert.equal(paint(box, 'Gradient Fill').value('ADBE Vector Grad Type'), 2, 'radial');
  assert.ok(!paint(box, 'Stroke').enabled && paint(box, 'Gradient Stroke').enabled);
  assert.equal(paint(box, 'Gradient Stroke').value('ADBE Vector Grad Type'), 1, 'linear');
  assert.equal(paint(box, 'Gradient Stroke').value('ADBE Vector Stroke Width'), 4);
});

test('colors, Apply to Box, Select Members and Release work from the panel', async () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const p = await openPanel(host);
  comp.select(title, sub);
  await p.click('[data-action="create"]');
  const box = comp.layer('AutoBox 1');
  assert.ok(!paint(box, 'Stroke').enabled, 'no stroke at width 0');

  await p.click('.swatch[data-pick="fillColor"]');
  assert.equal(p.$('.swatch[data-pick="fillColor"]').style.backgroundColor, 'rgb(51, 102, 153)');
  p.type('strokeWidth', 3);
  p.type('radius', 8);
  comp.select(box);
  await p.click('[data-action="apply"]');
  assert.equal(p.status().textContent, '');
  near(paint(box, 'Fill').value('ADBE Vector Fill Color'), [0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  assert.ok(paint(box, 'Stroke').enabled);
  assert.equal(paint(box, 'Stroke').value('ADBE Vector Stroke Width'), 3);
  assert.equal(box.boxRect().roundness, 8);

  await p.click('[data-action="select"]');
  assert.deepEqual(comp.selectedLayers.map((l) => l.name), ['Title', 'Subtitle']);

  comp.select(box);
  const before = box.boxRect();
  await p.click('[data-action="release"]');
  assert.equal(host.confirms.length, 1);
  assert.deepEqual(host.alerts, []);
  assert.equal(sizeExpression(box), '', 'the size is baked');
  assert.deepEqual(box.boxRect(), before);
  assert.ok(!hasEffect(box, 'Padding') && !hasEffect(box, 'Smart Animate'), 'the rig is removed');
});

test('the Animation section sets Smart Animate, Morph Time and Morph Ease', async () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const p = await openPanel(host);
  const v = (k) => p.settings()[k];
  const hot = p.$('.hot[data-key="morphTime"]');
  assert.ok(p.$('#smart-animate').checked);
  assert.equal(hot.textContent, '0.40', 'seconds, two decimals');
  assert.equal(p.$('#morph-ease').value, '4');

  p.$('#smart-animate').click();
  assert.equal(v('smartAnimate'), 0);
  p.type('morphTime', 1.234);
  assert.equal(v('morphTime'), 1.23);
  assert.equal(hot.textContent, '1.23');
  p.type('morphTime', 99);
  assert.equal(v('morphTime'), 60, 'at most a minute');
  p.type('morphTime', -1);
  assert.equal(v('morphTime'), 0, 'never negative');

  p.type('morphTime', 0.4);
  p.scrub('morphTime', [101, 102, 113]);
  assert.equal(v('morphTime'), 0.5, '0.01 s per pixel');
  p.scrub('morphTime', [110], { shiftKey: true });
  assert.equal(v('morphTime'), 1.2);
  hot.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(v('morphTime'), 1.21);

  await p.click('.prop[data-twirl="s-morphTime"] > .twirl');
  const slider = p.$('.slider[data-key="morphTime"]');
  p.rect(slider.querySelector('.track'), { left: 0, width: 200 });
  slider.dispatchEvent(p.mouse('mousedown', 50));
  p.w.document.dispatchEvent(p.mouse('mouseup', 50));
  assert.equal(v('morphTime'), 0.5, 'the slider runs from 0 to 2 s');
  assert.equal(slider.querySelector('.thumb').style.left, '25%');
  p.choose('#morph-ease', 2);
  assert.equal(v('morphEase'), 2);

  comp.select(title, sub);
  await p.click('[data-action="create"]');
  assert.deepEqual(host.alerts, []);
  const box = comp.layer('AutoBox 1');
  assert.equal(box.effectValue('Smart Animate'), 0);
  assert.equal(box.effectValue('Morph Time'), 0.5);
  assert.equal(box.effectValue('Morph Ease'), 2);

  p.type('padding', 10);
  await p.click('.reset[data-group="animation"]');
  assert.deepEqual([v('smartAnimate'), v('morphTime'), v('morphEase')], [1, 0.4, 4]);
  assert.ok(p.$('#smart-animate').checked);
  assert.equal(hot.textContent, '0.40');
  assert.equal(p.$('#morph-ease').value, '4');
  assert.equal(v('padding'), 10, 'other sections are untouched');
  assert.equal(JSON.parse(p.w.localStorage.getItem('braised.autobox.settings')).morphTime, 0.4);
});

test('Matte and In Box run on the selected box and layers', async () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const p = await openPanel(host);
  const lastCall = () => p.cep.calls[p.cep.calls.length - 1];
  comp.select(title, sub);
  await p.click('[data-action="create"]');
  const box = comp.layer('AutoBox 1');

  comp.select(box);
  await p.click('[data-action="matte"]');
  assert.match(lastCall(), /AutoBoxHost\.run\("matte", /);
  assert.equal(p.status().textContent, '');
  assert.deepEqual(host.alerts, []);
  assert.equal(title.trackMatteLayer, box);
  assert.equal(sub.trackMatteLayer, box);
  assert.ok(box.enabled, 'the box stays visible as the background');
  await p.click('[data-action="matte"]');
  assert.equal(title.trackMatteLayer, null, 'a second click takes the mattes off');
  assert.equal(sub.trackMatteLayer, null);

  comp.select(title);
  await p.click('[data-action="inbox"]');
  assert.match(lastCall(), /AutoBoxHost\.run\("inbox", /);
  assert.equal(p.status().textContent, '');
  assert.deepEqual(host.alerts, []);
  assert.equal(title.effectValue('In Box'), 1, 'on: nothing changes until it is keyframed');
  assert.ok(!hasEffect(sub, 'In Box'), 'only the selected layer gets one');
  assert.ok(!hasEffect(box, 'In Box'));
});

test('settings are remembered, old ones are dropped and each section resets to its defaults', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host, { storage: {
    padding: 12, anchor: 9, morphTime: 1.5, fillColor: [1, 0, 0], morphEase: 'x', radius: null,
    layout: 3, gap: 40, align: 2, justify: 4, fillColor2: [1, 1, 1], strokeColor2: [0, 0, 0], bogus: 5,
  } });
  assert.equal(p.$('.hot[data-key="padding"]').textContent, '12');
  assert.equal(p.$('.hot[data-key="morphTime"]').textContent, '1.50');
  assert.equal(p.$('#morph-ease').value, '4', 'bad stored values fall back to defaults');
  assert.equal(p.$('.hot[data-key="radius"]').textContent, '16');
  assert.equal(p.$('#anchor-name').textContent, 'Bottom Right');
  assert.equal(p.$('.swatch[data-pick="fillColor"]').style.backgroundColor, 'rgb(255, 0, 0)');
  const keys = Object.keys(p.w.AutoBoxPanel.DEFAULTS).sort();
  assert.deepEqual(Object.keys(p.settings()).sort(), keys, 'settings from older versions are dropped');

  await p.click('.reset[data-group="box"]');
  assert.equal(p.$('.hot[data-key="padding"]').textContent, '32');
  assert.equal(p.$('#anchor-name').textContent, 'Top Left', 'Box Anchor resets with the box');
  assert.equal(p.settings().morphTime, 1.5, 'other sections are untouched');
  assert.ok(p.$('.fx[data-twirl="g-box"]').classList.contains('open'), 'Reset does not collapse the section');
  const saved = JSON.parse(p.w.localStorage.getItem('braised.autobox.settings'));
  assert.deepEqual(Object.keys(saved).sort(), keys, 'and forgotten on the next save');
  await p.click('.reset[data-group="fill"]');
  assert.equal(p.$('.swatch[data-pick="fillColor"]').style.backgroundColor, 'rgb(27, 54, 67)');
  await p.click('.reset[data-group="animation"]');
  assert.equal(JSON.parse(p.w.localStorage.getItem('braised.autobox.settings')).morphTime, 0.4);
});

test('host errors and running outside After Effects are reported in the panel', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  p.cep.fail = true;
  await p.click('[data-action="create"]');
  assert.ok(p.status().classList.contains('error'));
  assert.match(p.status().textContent, /EvalScript error/);

  const q = await openPanel(host, { cep: null });
  assert.match(q.status().textContent, /inside After Effects/);
});

test('the built ZXP is signed and matches the sources', { skip: !fs.existsSync(path.join(ROOT, 'dist', 'AutoBox.zxp')) && 'run npm run build:zxp first' }, () => {
  const entries = readZip(fs.readFileSync(path.join(ROOT, 'dist', 'AutoBox.zxp')));
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  assert.equal(String(byName.get('mimetype')), 'application/vnd.adobe.air-ucf-package+zip');
  assert.match(String(byName.get('META-INF/signatures.xml')), /<SignatureValue/, 'signed');
  const files = (dir, base = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? files(path.join(dir, d.name), `${base}${d.name}/`) : [`${base}${d.name}`]);
  const staged = files(EXT_DIR);
  assert.ok(staged.includes('jsx/AutoBox.jsx'));
  staged.forEach((f) => {
    assert.ok(byName.has(f), `${f} is in the ZXP`);
    assert.ok(byName.get(f).equals(fs.readFileSync(path.join(EXT_DIR, f))), `${f} is up to date — rebuild with npm run build:zxp`);
  });
});

test('scrubbing: modifiers apply from the moment they are pressed, limits have no dead zone, lost mouseups end the drag', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  const v = (k) => p.settings()[k];
  p.scrub('padding', [123, 124], {});
  assert.equal(v('padding'), 53);
  const hot = p.$('.hot[data-key="padding"]');
  hot.dispatchEvent(p.mouse('mousedown', 100));
  p.w.document.dispatchEvent(p.mouse('mousemove', 120));
  assert.equal(v('padding'), 70);
  p.w.document.dispatchEvent(p.mouse('mousemove', 121, 0, { shiftKey: true }));
  assert.equal(v('padding'), 80, 'Shift scales only the new pixel: no jump');
  p.w.document.dispatchEvent(p.mouse('mousemove', 122));
  assert.equal(v('padding'), 81);
  p.w.document.dispatchEvent(p.mouse('mouseup', 122));

  p.scrub('radius', [40, 50]);
  assert.equal(v('radius'), 10, 'turns around right away after hitting 0');

  hot.dispatchEvent(p.mouse('mousedown', 100));
  p.w.document.dispatchEvent(p.mouse('mousemove', 110));
  p.w.document.dispatchEvent(p.mouse('mousemove', 300, 0, { buttons: 0 }));
  assert.equal(v('padding'), 88, 'a move without the button pressed ends the drag');
  p.w.document.dispatchEvent(p.mouse('mousemove', 400));
  assert.equal(v('padding'), 88);
  assert.equal(hot.querySelector('input'), null, 'and does not open the editor');

  p.type('padding', 'Infinity');
  assert.equal(v('padding'), 88, 'non-finite input is rejected');
  assert.equal(hot.textContent, '88');
});

test('the panel hands the keyboard back to After Effects', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  const sel = p.$('#morph-ease');
  sel.focus();
  sel.value = '2';
  sel.dispatchEvent(new p.w.Event('change'));
  assert.equal(p.w.document.activeElement, sel, 'keyboard users keep stepping through a menu');
  sel.dispatchEvent(p.mouse('mousedown', 1));
  sel.value = '3';
  sel.dispatchEvent(new p.w.Event('change'));
  assert.notEqual(p.w.document.activeElement, sel, 'after a mouse pick the menu gives up focus');
  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));

  const hot = p.$('.hot[data-key="morphTime"]');
  hot.focus();
  const asked = JSON.parse(p.cep.keyInterest[p.cep.keyInterest.length - 1]);
  assert.ok(asked.length >= 5 && asked.every((k) => typeof k.keyCode === 'number'), 'arrows/Enter requested while a value has focus');
  hot.blur();
  assert.equal(p.cep.keyInterest[p.cep.keyInterest.length - 1], '', 'and released afterwards');

  p.$('[data-action="select"]').dispatchEvent(p.mouse('mousedown', 1));
  assert.ok(p.w.document.body.classList.contains('pointer'), 'mouse users get no focus rings');

  // A mouse click on Reset leaves focus there; Space must still reach AE.
  const reset = p.$('.reset[data-group="box"]');
  reset.dispatchEvent(p.mouse('mousedown', 1));
  reset.focus();
  const codes = JSON.parse(p.cep.keyInterest[p.cep.keyInterest.length - 1]).map((k) => k.keyCode);
  assert.ok(!codes.includes(32) && !codes.includes(49), 'no Space after a mouse click');
  assert.ok(codes.includes(9) || codes.includes(48), 'Tab still moves focus');
  reset.blur();

  p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.ok(!p.w.document.body.classList.contains('pointer'));
  reset.focus();
  const kb = JSON.parse(p.cep.keyInterest[p.cep.keyInterest.length - 1]).map((k) => k.keyCode);
  assert.ok(kb.includes(32) || kb.includes(49), 'keyboard users can press Space on Reset');
});

test('colors follow After Effects brightness', async () => {
  const host = createHost();
  scene(host);
  const at = async (gray) => {
    const cep = fakeCep();
    cep.getHostEnvironment = () => JSON.stringify({ appSkinInfo: { baseFontSize: 10, panelBackgroundColor: { color: { red: gray, green: gray, blue: gray } } } });
    const p = await openPanel(host, { cep });
    const st = p.w.document.documentElement.style;
    return { light: p.w.document.documentElement.classList.contains('light'), hot: st.getPropertyValue('--hot'), line: st.getPropertyValue('--line'), size: st.getPropertyValue('--font-size') };
  };
  const dark = await at(29);
  assert.equal(dark.light, false);
  assert.equal(dark.hot, 'rgb(94,170,247)', 'After Effects\' own blue at default brightness');
  assert.equal(dark.line, 'rgb(14,14,14)');
  assert.equal(dark.size, '10px');
  assert.equal((await at(184)).light, true);

  const lum = (c) => {
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const parse = (css) => css.match(/\d+/g).map(Number);
  for (let gray = 20; gray <= 240; gray += 10) {
    const t = await at(gray);
    const hot = parse(t.hot), head = t.light ? gray - 16 : gray + 19;
    assert.ok(ratio(hot, [gray, gray, gray]) >= 3, `values readable on the panel at gray ${gray}`);
    assert.ok(ratio(hot, [head, head, head]) >= 3, `Reset readable on the header at gray ${gray}`);
  }
});

test('huge numbers are rejected and quick clicks still open the editor', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  p.choose('#fill-type', 2);
  p.type('fillAngle', '1e308');
  assert.equal(p.settings().fillAngle, 100000, 'clamped instead of becoming Infinity');
  assert.match(p.$('.hot[data-key="fillAngle"]').textContent, /^277x\+280\.0\u00b0$/);
  p.type('fillAngle', 'Infinity');
  assert.equal(p.settings().fillAngle, 100000, 'non-finite input is rejected');
  p.type('padding', '1e9');
  assert.equal(p.settings().padding, 100000, 'clamped to the field range');

  // macOS can report a move with no buttons after a quick click: still a click.
  const hot = p.$('.hot[data-key="morphTime"]');
  hot.dispatchEvent(p.mouse('mousedown', 50));
  p.w.document.dispatchEvent(p.mouse('mousemove', 51, 0, { buttons: 0 }));
  assert.ok(hot.querySelector('input'), 'the editor opens');
});
