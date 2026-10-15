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
const { createHost, SCRIPT_PATH } = require('./ae-mock');
const { stageExtension } = require('../scripts/build-zxp');

const ROOT = path.join(__dirname, '..');
const CEP = path.join(ROOT, 'cep');
const PANEL_JS = fs.readFileSync(path.join(CEP, 'js', 'panel.js'), 'utf8');
const HTML = fs.readFileSync(path.join(CEP, 'index.html'), 'utf8');
const EXT_DIR = stageExtension(fs.mkdtempSync(path.join(os.tmpdir(), 'autobox ext ')));

const tick = () => new Promise((r) => setImmediate(r));

function fakeCep() {
  return {
    calls: [],
    fail: false,
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

async function openPanel(host, { cep = fakeCep(), storage } = {}) {
  globalThis.$.global = globalThis;
  globalThis.$.evalFile = (p) => vm.runInThisContext(fs.readFileSync(String(p), 'utf8'), { filename: String(p) });
  delete globalThis.AutoBoxHost;
  const dom = new JSDOM(HTML, { url: 'https://autobox.test/', runScripts: 'outside-only' });
  const w = dom.window;
  if (storage) w.localStorage.setItem('braised.autobox.settings', JSON.stringify(storage));
  if (cep) w.__adobe_cep__ = cep;
  w.eval(PANEL_JS);
  await tick();
  await tick();
  const $ = (sel) => w.document.querySelector(sel);
  return {
    w, cep, $,
    status: () => $('#status'),
    async click(sel) {
      $(sel).click();
      await tick();
      await tick();
    },
    change(sel, value) {
      const el = $(sel);
      el.value = String(value);
      el.dispatchEvent(new w.Event('change'));
    },
  };
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

  await p.click('.seg[data-key="layout"] button[data-value="2"]');
  assert.ok(p.$('.seg[data-key="layout"] button[data-value="2"]').classList.contains('on'));
  assert.ok(!p.w.document.body.classList.contains('is-free'));
  p.change('#padding', 20);
  p.change('#radius', -5);
  assert.equal(p.$('#radius').value, '0', 'min is enforced');
  await p.click('.anchor button[data-value="5"]');
  assert.equal(p.$('#anchor-name').textContent, 'Center');

  comp.select(title, sub);
  await p.click('[data-action="create"]');
  assert.deepEqual(host.alerts, []);
  assert.equal(p.status().textContent, '');
  const box = comp.layer('AutoBox 1');
  assert.equal(box.effectValue('Layout'), 2);
  assert.equal(box.effectValue('Padding'), 20);
  assert.equal(box.effectValue('Box Anchor'), 5);
  assert.equal(box.boxRect().roundness, 0);
  assert.equal(title.parent, box);
  assert.equal(sub.parent, box);

  const saved = JSON.parse(p.w.localStorage.getItem('braised.autobox.settings'));
  assert.equal(saved.padding, 20);
  assert.equal(saved.layout, 2);
});

test('colors, Apply to Box, Select Members and Release work from the panel', async () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const p = await openPanel(host);
  comp.select(title, sub);
  await p.click('[data-action="create"]');
  const box = comp.layer('AutoBox 1');

  await p.click('.swatch[data-key="fillColor"]');
  assert.equal(p.$('.swatch[data-key="fillColor"]').style.background, 'rgb(51, 102, 153)');
  p.change('#strokeWidth', 3);
  comp.select(box);
  await p.click('[data-action="apply"]');
  assert.deepEqual(box.effectValue('Fill Color'), [0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  assert.equal(box.effectValue('Stroke Width'), 3);

  await p.click('[data-action="select"]');
  assert.deepEqual(comp.selectedLayers.map((l) => l.name), ['Title', 'Subtitle']);

  comp.select(box);
  await p.click('[data-action="release"]');
  assert.equal(host.confirms.length, 1);
  assert.equal(title.tprop('ADBE Position').expression, '');
  assert.deepEqual(host.alerts, []);
});

test('settings are remembered and Reset restores the defaults', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host, { storage: { padding: 12, layout: 3, fillColor: [1, 0, 0], bogus: 5, gap: 'x' } });
  assert.equal(p.$('#padding').value, '12');
  assert.equal(p.$('#gap').value, '16', 'bad stored values fall back to defaults');
  assert.ok(p.$('.seg[data-key="layout"] button[data-value="3"]').classList.contains('on'));
  assert.equal(p.$('.swatch[data-key="fillColor"]').style.background, 'rgb(255, 0, 0)');
  await p.click('[data-action="reset"]');
  assert.equal(p.$('#padding').value, '32');
  assert.equal(JSON.parse(p.w.localStorage.getItem('braised.autobox.settings')).layout, 1);
});

test('dragging a label scrubs its value', async () => {
  const host = createHost();
  scene(host);
  const p = await openPanel(host);
  const label = p.$('label[for="gap"]');
  const ev = (type, x, shift) => new p.w.MouseEvent(type, { bubbles: true, clientX: x, shiftKey: !!shift });
  label.dispatchEvent(ev('mousedown', 100));
  p.w.document.dispatchEvent(ev('mousemove', 110));
  assert.equal(p.$('#gap').value, '26');
  p.w.document.dispatchEvent(ev('mousemove', 102, true));
  assert.equal(p.$('#gap').value, '36');
  p.w.document.dispatchEvent(ev('mouseup', 102));
  p.w.document.dispatchEvent(ev('mousemove', 300));
  assert.equal(p.$('#gap').value, '36', 'stops after mouseup');
  assert.equal(p.w.AutoBoxPanel.settings().gap, 36);
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
