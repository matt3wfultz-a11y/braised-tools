'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const acorn = require('acorn');
const path = require('path');
const vm = require('vm');
const { createHost, Prop, SCRIPT_PATH, features, TRACK_MATTE } = require('./ae-mock');

const FIXTURES = path.join(__dirname, 'fixtures');
const smooth = (f) => f * f * (3 - 2 * f);

function near(actual, expected, msg) {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, msg);
    expected.forEach((e, i) => near(actual[i], e, `${msg || ''}[${i}]`));
    return;
  }
  assert.ok(Math.abs(actual - expected) < 1e-4, `${msg || 'value'}: expected ${expected}, got ${actual}`);
}

function bounds(b, l, t, r, bot, msg) {
  near([b.l, b.t, b.r, b.b], [l, t, r, bot], msg);
}

function settings(host, overrides) {
  return Object.assign({}, host.api.DEFAULTS, overrides);
}

// Title (layer 1) above Subtitle (layer 2), both left-aligned point text with
// the anchor on the baseline, like fresh text layers in After Effects.
function scene(host, opts = {}) {
  const comp = host.newComp(Object.assign({ duration: 10 }, opts.comp));
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  return { comp, title, sub };
}

function create(host, comp, layers, overrides) {
  comp.select(...layers);
  host.api.createBox(settings(host, overrides));
  assert.deepEqual(host.alerts, [], 'no alerts');
  assert.equal(host.undoDepth, 0, 'undo groups balanced');
  return comp._layers.find((l) => l.name.indexOf('AutoBox') === 0 && l.selected);
}

// Keyframes straight into the mock: [time, value, ease?] (ease shapes the
// segment that starts at that key).
function keys(prop, list) {
  const s = prop instanceof Prop ? prop.s : prop;
  s.keys = list.map(([t, v, ease]) => ({ t, v: Array.isArray(v) ? v.slice() : v, ease, hold: ease === 'hold' }));
  s.keys.forEach((k) => { if (k.ease === 'hold') delete k.ease; });
}

// Slide a layer's position: offsets [[time, dx, dy, ease?], ...] from where it is.
function slide(layer, list) {
  const pos = layer.tprop('ADBE Position');
  const v = pos.valueAtTime(0, true);
  keys(pos, list.map(([t, dx, dy, ease]) => [t, [v[0] + dx, v[1] + dy, v[2] || 0], ease]));
}

// The box's rect at time t, in its own layer space.
function rect(box, t) {
  return box.boxRect(t);
}

function items(box) {
  return box.contentsState.children.find((c) => c.name === 'AutoBox').children[0].children;
}

function item(box, name) {
  const c = items(box).find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} in ${box.name}`);
  return (mn) => new Prop(c.children.find((x) => x.matchName === mn));
}

function enabled(box) {
  return items(box).map((c) => `${c.name}${c.enabled ? '' : ' (off)'}`);
}

// Every expression in the comp, as "Layer > Property".
function expressions(comp) {
  const out = [];
  const walk = (l, s) => {
    if (s.expression) out.push(`${l.name} > ${s.name}`);
    s.children.forEach((c) => walk(l, c));
  };
  comp._layers.forEach((l) => walk(l, l.root));
  return out;
}

function oldApi(file) {
  globalThis.AUTOBOX_TEST = {};
  vm.runInThisContext(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
  return globalThis.AUTOBOX_TEST.api;
}

// ---------------------------------------------------------------------------
// Building a box
// ---------------------------------------------------------------------------
test('script and every expression it writes are plain ES3 (Legacy ExtendScript engine)', () => {
  const host = createHost();
  // allowReserved: false: ES3 also reserves words like short, int and class.
  const es3 = { ecmaVersion: 3, allowReserved: false };
  acorn.parse(fs.readFileSync(SCRIPT_PATH, 'utf8'), es3);
  for (const kind of ['size', 'position']) acorn.parse(host.api.buildExpression(kind, [[0, 0, 10, 10, 1]]), es3);
  acorn.parse(host.api.buildSwitchProbe(3, 1), es3);
  acorn.parse(host.api.gradientPointExpression(), es3);
});

test('the engine only reads controls that every box gets', () => {
  const host = createHost();
  const expr = host.api.buildExpression('size');
  const names = new Set(host.api.CONTROLS.map((c) => c.name));
  const used = [...expr.matchAll(/ab_ctl(?:At)?\("([^"]+)"/g), ...expr.matchAll(/AB_BOX\.effect\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 12);
  used.forEach((n) => assert.ok(names.has(n), `missing control ${n}`));
});

test('Create Box wraps the selection with padding, leaves the layers alone and gives them no expressions', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);

  assert.equal(box.name, 'AutoBox 1');
  assert.deepEqual(comp._layers.map((l) => l.name), ['Title', 'Subtitle', 'AutoBox 1'], 'one box layer behind its layers');
  assert.equal(title.parent, box);
  assert.equal(sub.parent, box);
  bounds(title.compBounds(), 200, 250, 600, 310, 'title unchanged');
  bounds(sub.compBounds(), 220, 350, 520, 386, 'subtitle unchanged');
  bounds(box.boxCompBounds(), 168, 218, 632, 418, 'box = union + 32px padding');
  near(box.tprop('ADBE Position').value.slice(0, 2), [168, 218], 'box layer sits on its top-left anchor');
  assert.deepEqual(expressions(comp).sort(), [
    'AutoBox 1 > End Point', 'AutoBox 1 > End Point', 'AutoBox 1 > Position', 'AutoBox 1 > Size',
    'AutoBox 1 > Start Point', 'AutoBox 1 > Start Point',
  ], 'only the rect and the gradient points carry expressions');
  assert.deepEqual(box.effectsState.children.map((e) => e.name), host.api.CONTROLS.map((c) => c.name));
  assert.deepEqual(box.effectsState.children.find((e) => e.name === 'Morph Ease').children[0].items,
    ['Linear', 'Ease In', 'Ease Out', 'Ease In Out']);
  near(box.effectValue('Smart Animate'), 1);
  near(box.effectValue('Morph Time'), 0.4);
  near(box.effectValue('Freeze'), 0);
  assert.ok(host.undoGroups.includes('AutoBox: Create Box'));
});

test('the look is plain native shape items: strokes above fills, the unused ones switched off', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillColor: [1, 0.5, 0], radius: 24 });
  assert.deepEqual(enabled(box), ['Box Rect', 'Stroke (off)', 'Gradient Stroke (off)', 'Fill', 'Gradient Fill (off)']);
  near(item(box, 'Fill')('ADBE Vector Fill Color').value, [1, 0.5, 0, 1]);
  near(item(box, 'Fill')('ADBE Vector Fill Opacity').value, 100);
  const roundness = item(box, 'Box Rect')('ADBE Vector Rect Roundness');
  near(roundness.value, 24, 'corner radius is the native Roundness');
  assert.equal(roundness.s.expression, '');
  assert.equal(item(box, 'Fill')('ADBE Vector Fill Color').s.expression, '');
  // A gradient that's off still spans the box, so its eyeball is all it takes.
  near(item(box, 'Gradient Fill')('ADBE Vector Grad Start Pt').s.value, [-50, 0]);
  near(item(box, 'Gradient Fill')('ADBE Vector Grad End Pt').s.value, [50, 0]);
});

test('a stroke and gradients from the panel', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillType: 2, fillAngle: 0, strokeWidth: 6, strokeType: 3, strokeOpacity: 50 });
  assert.deepEqual(enabled(box), ['Box Rect', 'Stroke (off)', 'Gradient Stroke', 'Fill (off)', 'Gradient Fill']);
  const gf = item(box, 'Gradient Fill'), gs = item(box, 'Gradient Stroke');
  near(gf('ADBE Vector Grad Type').value, 1, 'linear');
  near(gs('ADBE Vector Grad Type').value, 2, 'radial');
  near(gs('ADBE Vector Stroke Width').value, 6);
  near(gs('ADBE Vector Stroke Opacity').value, 50);
  // Start/End Point are % of the box: 0 degrees runs bottom to top.
  near(gf('ADBE Vector Grad Start Pt').s.value, [0, 50]);
  near(gf('ADBE Vector Grad End Pt').s.value, [0, -50]);
  const r = rect(box, 0);
  near(gf('ADBE Vector Grad Start Pt').value, [(r.l + r.r) / 2, r.b]);
  near(gf('ADBE Vector Grad End Pt').value, [(r.l + r.r) / 2, r.t]);
  near(gs('ADBE Vector Grad Start Pt').value, [(r.l + r.r) / 2, (r.t + r.b) / 2], 'radial from the center');
  near(gs('ADBE Vector Grad End Pt').value, [r.r, r.b], 'to the corner');
  // The gradient stretches as the box does.
  box.setEffect('Padding', 50);
  const r2 = rect(box, 0);
  near(gf('ADBE Vector Grad End Pt').value, [(r2.l + r2.r) / 2, r2.t]);
  // 45 degrees: corner to corner.
  near(host.api.gradientPoints(2, 45)[0], [-50, 50]);
  near(host.api.gradientPoints(2, 45)[1], [50, -50]);
});

test('padding, extra padding and min size are live; min size grows away from Box Anchor', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { padding: 10 });
  bounds(box.boxCompBounds(), 190, 240, 610, 320);
  box.setEffect('Extra Left', 30);
  box.setEffect('Extra Bottom', 5);
  bounds(box.boxCompBounds(), 160, 240, 610, 325);
  box.setEffect('Min Width', 600);
  bounds(box.boxCompBounds(), 160, 240, 760, 325, 'Top Left anchor: grows right');
  box.setEffect('Box Anchor', 6);
  bounds(box.boxCompBounds(), 10, 240, 610, 325, 'Right anchor: grows left');
  box.setEffect('Box Anchor', 5);
  box.setEffect('Min Height', 285);
  bounds(box.boxCompBounds(), 85, 140, 685, 425, 'Center: grows both ways');
});

test('Apply to Box pushes the panel onto the box but leaves animated properties alone', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  const color = item(box, 'Fill')('ADBE Vector Fill Color');
  color.setValueAtTime(0, [1, 0, 0, 1]);
  color.setValueAtTime(1, [0, 0, 1, 1]);
  const pad = box.effectsState.children.find((e) => e.name === 'Padding').children[0];
  new Prop(pad).setValueAtTime(0, 10);
  comp.select(box);
  host.api.applySettings(settings(host, { padding: 50, radius: 40, fillColor: [0, 1, 0], fillOpacity: 60, minWidth: 900, morphTime: 1.5 }));
  assert.deepEqual(host.alerts, []);
  near(color.valueAtTime(1, false), [0, 0, 1, 1], 'keyframed color kept');
  assert.equal(pad.keys.length, 1, 'keyframed control kept');
  near(item(box, 'Fill')('ADBE Vector Fill Opacity').value, 60);
  near(item(box, 'Box Rect')('ADBE Vector Rect Roundness').value, 40);
  near(box.effectValue('Min Width'), 900);
  near(box.effectValue('Morph Time'), 1.5);
  // Freeze isn't a panel setting: Apply never touches it.
  box.setEffect('Freeze', 1);
  host.api.applySettings(settings(host));
  near(box.effectValue('Freeze'), 1);
});

test('gradient colors are never touched (scripts cannot read or set them)', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillType: 3, strokeType: 2, strokeWidth: 2 });
  comp.select(box);
  host.api.applySettings(settings(host, { fillType: 2 }));
  host.confirmAnswer = true;
  host.api.releaseBoxes();
  // The mock throws on any access to the Colors property; reaching here means none happened.
  assert.deepEqual(host.alerts, []);
});

test('shape items are only ever appended: the mock fails like After Effects after a moveTo', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  const vec = box.contentsState.children[0].children[0];
  new Prop(vec.children[1]).moveTo(5);
  assert.throws(() => new Prop(box.effectsState).addProperty('ADBE Tint'),
    /internal verification failure, sorry! \{stream at index matchName="ADBE Vector Graphic - G-Stroke" \(mismatch with resultP, expected "ADBE Vector Graphic - Fill"\)\}/);
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
test('Matte makes the box its layers\' track matte and keeps it visible; again takes the mattes off', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  const icon = comp.layers.addShapeMember('Icon', { position: [180, 280], rect: { left: 0, top: 0, width: 10, height: 10 } });
  icon.parent = title; // rides along
  comp.select(title);
  host.api.matteBoxes();
  assert.deepEqual(host.alerts, []);
  for (const l of [title, sub, icon]) {
    assert.equal(l.trackMatteLayer, box, `${l.name} uses the box`);
    assert.equal(l.trackMatteType, TRACK_MATTE.ALPHA);
  }
  assert.equal(box.enabled, true, 'the box still shows as the background');
  assert.ok(host.undoGroups.includes('AutoBox: Matte'));
  comp.select(box);
  host.api.matteBoxes();
  for (const l of [title, sub, icon]) assert.equal(l.trackMatteLayer, null);
  assert.equal(box.enabled, true);
});

test('Matte explains when After Effects is older than 2023', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  features.setTrackMatte = false;
  try {
    comp.select(box);
    host.api.matteBoxes();
    assert.match(host.alerts.pop(), /After Effects 2023/);
    assert.equal(title.trackMatteLayer, null);
  } finally {
    features.setTrackMatte = true;
  }
});

test('Add to Box and Remove (layers never jump)', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title]);
  bounds(box.boxCompBounds(), 168, 218, 632, 342);
  comp.select(box, sub);
  host.api.addToBox();
  assert.deepEqual(host.alerts, []);
  assert.equal(sub.parent, box);
  bounds(sub.compBounds(), 220, 350, 520, 386);
  bounds(box.boxCompBounds(), 168, 218, 632, 418);
  comp.select(sub);
  host.api.removeFromBox();
  assert.equal(sub.parent, null);
  bounds(sub.compBounds(), 220, 350, 520, 386);
  bounds(box.boxCompBounds(), 168, 218, 632, 342);
  assert.deepEqual(expressions(comp).filter((n) => !n.startsWith('AutoBox')), []);
});

test('Release bakes the box\'s size and gradients, removes the rig and In Box checkboxes, keeps the look', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { fillType: 2, anchor: 5 });
  slide(title, [[1, 0, 100, smooth], [1.5, 0, 0]]);
  comp.select(title);
  host.api.addInBoxToggles();
  const live = [0, 1.2, 1.5, 3].map((t) => rect(box, t));
  const grad = [0, 1.2, 3].map((t) => item(box, 'Gradient Fill')('ADBE Vector Grad End Pt').valueAtTime(t, false));
  comp.select(box);
  host.confirmAnswer = true;
  host.api.releaseBoxes();
  assert.deepEqual(box.effectsState.children.map((e) => e.name), []);
  assert.deepEqual(title.effectsState.children.map((e) => e.name), [], 'In Box removed');
  assert.deepEqual(expressions(comp), []);
  [0, 1.2, 1.5, 3].forEach((t, i) => {
    const r = rect(box, t);
    near([r.l, r.t, r.r, r.b], [live[i].l, live[i].t, live[i].r, live[i].b], `baked at ${t}`);
  });
  [0, 1.2, 3].forEach((t, i) => near(item(box, 'Gradient Fill')('ADBE Vector Grad End Pt').valueAtTime(t, false), grad[i]));
  assert.deepEqual(enabled(box), ['Box Rect', 'Stroke (off)', 'Gradient Stroke (off)', 'Fill (off)', 'Gradient Fill']);
});

test('Select Members selects the box\'s layers, riders included', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  const icon = comp.layers.addShapeMember('Icon', { position: [180, 280] });
  icon.parent = title;
  comp.select(box);
  host.api.selectMembers();
  assert.deepEqual(comp.selectedLayers.map((l) => l.name).sort(), ['Icon', 'Subtitle', 'Title']);
});

test('nothing selected, or no box, gives a friendly message', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  comp.select();
  host.api.createBox(settings(host));
  assert.match(host.alerts.pop(), /Select the layers/);
  for (const fn of ['applySettings', 'selectMembers', 'matteBoxes', 'releaseBoxes']) {
    comp.select(title);
    host.api[fn](settings(host));
    assert.match(host.alerts.pop(), /Select a box layer/, fn);
  }
  comp.select(title);
  host.api.addInBoxToggles();
  assert.match(host.alerts.pop(), /Select layers inside a box/);
  comp.select(title);
  host.api.addToBox();
  assert.match(host.alerts.pop(), /Select a box layer and the layers/);
});

test('cameras and nulls are skipped; a camera parented to a box cannot break it', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const cam = comp.layers.addCamera('Camera 1');
  const nul = comp.layers.addNull();
  comp.select(title, cam, nul);
  host.api.createBox(settings(host));
  assert.match(host.alerts.pop(), /Camera 1 — cameras, lights, nulls/);
  const box = comp.layer('AutoBox 1');
  cam.parent = box;
  bounds(box.boxCompBounds(), 168, 218, 632, 342);
  assert.equal(item(box, 'Box Rect')('ADBE Vector Rect Size').s.expressionError, '');
});

test('editing text, renaming, reordering and duplicating layers never break a box', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  title.sourceText = 'A much longer title';
  title.setText({ left: 0, top: -50, width: 700, height: 60 });
  bounds(box.boxCompBounds(), 168, 218, 932, 418, 'follows the edited text');
  sub.name = 'Renamed';
  sub.moveToBeginning();
  const copy = sub.duplicate();
  copy.tprop('ADBE Position').s.value = [52, 252, 0]; // box space: comp 220, 470
  bounds(box.boxCompBounds(), 168, 218, 932, 508, 'the duplicate is parented to the box, so it counts');
  sub.remove();
  bounds(box.boxCompBounds(), 168, 218, 932, 508);
});

test('the ScriptUI panel builds, remembers settings and its buttons work', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const panel = new Panel();
  host.api.buildUI(panel);
  const find = (pred) => panel.find(pred);
  const radius = find((c) => c.type === 'edittext' && /Corner radius/.test(c.helpTip));
  radius.text = '24';
  radius.onChange.call(radius);
  const morph = find((c) => c.type === 'slider' && /Morph Time/.test(c.helpTip));
  morph.value = 1.234;
  morph.onChange.call(morph);
  const ease = find((c) => c.type === 'dropdownlist' && c.items.length === 4 && c.items[0].text === 'Linear');
  ease.selection = 0;
  ease.onChange.call(ease);
  const smart = find((c) => c.type === 'checkbox' && c.text === 'Smart Animate');
  smart.value = false;
  smart.onClick.call(smart);

  comp.select(title, sub);
  const button = (label) => find((c) => c.type === 'button' && c.text === label);
  button('Create Box').onClick();
  assert.deepEqual(host.alerts, []);
  const box = comp.layer('AutoBox 1');
  near(item(box, 'Box Rect')('ADBE Vector Rect Roundness').value, 24);
  near(box.effectValue('Morph Time'), 1.23);
  near(box.effectValue('Morph Ease'), 1);
  near(box.effectValue('Smart Animate'), 0);

  button('Select Members').onClick();
  assert.deepEqual(comp.selectedLayers.map((l) => l.name), ['Title', 'Subtitle']);
  button('In Box').onClick();
  assert.ok(title.effectsState.children.some((e) => e.name === 'In Box'));
  comp.select(box);
  button('Matte').onClick();
  assert.equal(title.trackMatteLayer, box);
  button('?').onClick();
  assert.match(host.alerts.pop(), /SMART ANIMATE/);

  const panel2 = new Panel();
  host.api.buildUI(panel2);
  assert.equal(panel2.find((c) => c.type === 'edittext' && /Corner radius/.test(c.helpTip)).text, '24');
  const swatch = panel2.find((c) => c.type === 'button' && /^Fill color/.test(c.helpTip));
  swatch.onDraw();
  swatch.onClick();
  comp.select(box);
  panel2.find((c) => c.type === 'button' && c.text === 'Apply to Box').onClick();
  near(item(box, 'Fill')('ADBE Vector Fill Color').value, [0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  assert.deepEqual(host.alerts, []);
});

test('the CEP entry point runs actions by name and reports errors', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  comp.select(title);
  assert.equal(host.api.hostRun('create', { padding: 10, fillColor: [1, 0, 0] }), 'ok');
  const box = comp.layer('AutoBox 1');
  near(box.effectValue('Padding'), 10);
  assert.equal(host.api.hostRun('nope', {}), 'Unknown action: nope');
  host.app.project.activeItem = { not: 'a comp' };
  assert.equal(host.api.hostRun('apply', {}), 'ok');
  assert.match(host.alerts.pop(), /Open a composition/);
});

// ---------------------------------------------------------------------------
// Boxes made by older versions
// ---------------------------------------------------------------------------
function oldScene(file, opts) {
  const host = createHost();
  const old = oldApi(file);
  const comp = host.newComp();
  const ctrl = opts && opts.controller ? comp.layers.addNull({ name: 'Ctrl', position: [100, 100] }) : null;
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  if (ctrl) sub.parent = ctrl;
  comp.select(title, sub);
  old.createBox(Object.assign({}, old.DEFAULTS, opts && opts.settings));
  const box = comp.layer('AutoBox 1');
  host.alerts.length = 0;
  return { host, comp, box, title, sub, ctrl };
}

test('an AutoBox 2 box keeps working, and Apply converts it once, keeping its look and its layers in place', () => {
  const { host, comp, box, title, sub } = oldScene('AutoBox-2.0.1.jsx', {
    settings: { layout: 2, padding: 20, fillType: 2, fillColor: [1, 0, 0], strokeWidth: 3, strokeColor: [0, 1, 0], radius: 12 },
  });
  assert.deepEqual(comp._layers.map((l) => l.name), ['Title', 'Subtitle', 'AutoBox 1 Stroke', 'AutoBox 1']);
  const before = { title: title.compBounds(), sub: sub.compBounds(), box: box.boxCompBounds() };
  comp.select(box);
  host.api.applySettings(settings(host, { padding: 99 }));
  assert.equal(host.confirms.length, 1);
  assert.match(host.confirms[0], /AutoBox 1 was made with an older AutoBox\. Convert to AutoBox 3/);
  assert.equal(host.alerts.length, 1);
  assert.match(host.alerts[0], /Converted to AutoBox 3[\s\S]*its stack is now plain layers[\s\S]*gradient colors are back to white and black/);
  assert.deepEqual(comp._layers.map((l) => l.name), ['Title', 'Subtitle', 'AutoBox 1'], 'stroke layer gone');
  assert.deepEqual(box.effectsState.children.map((e) => e.name).sort(), host.api.CONTROLS.map((c) => c.name).sort(),
    'old controls and the Tint replaced by the 3.0 controls');
  near(box.effectValue('Padding'), 20, 'its own settings, not the panel\'s');
  bounds(title.compBounds(), ...Object.values(before.title));
  bounds(sub.compBounds(), ...Object.values(before.sub));
  bounds(box.boxCompBounds(), ...Object.values(before.box));
  assert.deepEqual(expressions(comp).filter((n) => !n.startsWith('AutoBox 1 >')), [], 'no member expressions left');
  assert.deepEqual(enabled(box), ['Box Rect', 'Stroke', 'Gradient Stroke (off)', 'Fill (off)', 'Gradient Fill']);
  near(item(box, 'Fill')('ADBE Vector Fill Color').value, [1, 0, 0, 1]);
  near(item(box, 'Stroke')('ADBE Vector Stroke Color').value, [0, 1, 0, 1]);
  near(item(box, 'Stroke')('ADBE Vector Stroke Width').value, 3);
  near(item(box, 'Box Rect')('ADBE Vector Rect Roundness').value, 12);
  // Converted: the next Apply applies the panel.
  host.confirms.length = 0;
  host.alerts.length = 0;
  host.api.applySettings(settings(host, { padding: 40 }));
  assert.deepEqual(host.confirms, []);
  assert.deepEqual(host.alerts, []);
  near(box.effectValue('Padding'), 40);
});

test('declining the conversion leaves an old box untouched', () => {
  const { host, comp, box } = oldScene('AutoBox-2.0.1.jsx', { settings: { layout: 2 } });
  const names = box.effectsState.children.map((e) => e.name);
  host.confirmAnswer = false;
  comp.select(box);
  host.api.applySettings(settings(host));
  assert.deepEqual(box.effectsState.children.map((e) => e.name), names);
  assert.deepEqual(host.alerts, []);
});

test('a box made by AutoBox 1.0 converts, adopting the layers it tracked by name if you say so', () => {
  const { host, comp, box, title, sub, ctrl } = oldScene('AutoBox-1.0.0.jsx', {
    controller: true, settings: { layout: 2, padding: 20, fillColor: [1, 0, 0] },
  });
  const before = sub.compBounds();
  comp.select(box);
  host.api.applySettings(settings(host));
  assert.equal(host.confirms.length, 2);
  assert.match(host.confirms[1], /AutoBox 1\.0, which left these layers parented to other layers:\s+Subtitle \(parented to Ctrl\)/);
  assert.match(host.alerts[0], /AutoBox 1 \(its stack is now plain layers[^)]*now parented to it: Subtitle\)/);
  assert.equal(sub.parent, box);
  assert.equal(title.parent, box);
  bounds(sub.compBounds(), ...Object.values(before));
  near(item(box, 'Fill')('ADBE Vector Fill Color').value, [1, 0, 0, 1]);
  assert.deepEqual(expressions(comp).filter((n) => !n.startsWith('AutoBox 1 >')), []);
  assert.ok(ctrl);
});

test('Create Box inside an old box asks you to convert it first', () => {
  const { host, comp, title } = oldScene('AutoBox-2.0.1.jsx', { settings: { layout: 2 } });
  comp.select(title);
  host.api.createBox(settings(host));
  assert.match(host.alerts.pop(), /made with an older AutoBox\. Select it and click Apply to Box to convert it/);
  assert.equal(comp._layers.filter((l) => /^AutoBox/.test(l.name)).length, 2);
});

test('Release still bakes an old box in place', () => {
  const { host, comp, box, title, sub } = oldScene('AutoBox-2.0.1.jsx', { settings: { layout: 2, padding: 20 } });
  const before = { title: title.compBounds(), sub: sub.compBounds(), box: box.boxCompBounds() };
  comp.select(box);
  host.confirmAnswer = true;
  host.api.releaseBoxes();
  bounds(title.compBounds(), ...Object.values(before.title));
  bounds(sub.compBounds(), ...Object.values(before.sub));
  bounds(box.boxCompBounds(), ...Object.values(before.box));
  assert.ok(!box.effectsState.children.some((e) => e.name === 'Layout'));
  assert.ok(box.effectsState.children.some((e) => e.name === 'Fill Color'), '2.x paint controls stay (its stroke layer uses them)');
});

// ---------------------------------------------------------------------------
// Smart Animate
// ---------------------------------------------------------------------------
// One title box, padding 20 (box 440 x 100 around the title), Box Anchor Center.
function titleBox(overrides) {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.remove();
  const box = create(host, comp, [title], Object.assign({ padding: 20, anchor: 5 }, overrides));
  return { host, comp, title, box };
}

test('layers with no keyframes are there from the first frame', () => {
  const { box } = titleBox();
  for (const t of [0, 2, 9]) near([rect(box, t).w, rect(box, t).h], [440, 100], `at ${t}`);
});

test('a layer sliding in: the box grows from the side it comes from, on its curve, and holds while it leaves', () => {
  const { box, title } = titleBox();
  slide(title, [[1, 0, 200, smooth], [1.5, 0, 0], [3, 0, 0, smooth], [3.5, 0, -200]]);
  const full = rect(box, 2);
  near([full.w, full.h], [440, 100]);
  near([rect(box, 0.5).w, rect(box, 0.5).h], [0, 0], 'nothing before it comes in');
  for (const t of [1.1, 1.25, 1.4]) {
    const p = smooth((t - 1) / 0.5), r = rect(box, t);
    near([r.l, r.t, r.r, r.b], [full.l, full.b - 100 * p, full.r, full.b], `rising from the bottom edge at ${t}`);
  }
  for (const t of [3.2, 3.5, 6]) near([rect(box, t).w, rect(box, t).h], [440, 100], `holds while it leaves (${t})`);
});

test('Grow From: Box Anchor, Snap, and Motion for slides, scale-ins and fades', () => {
  let { box, title } = titleBox({ anchor: 4, growFrom: 2 });
  slide(title, [[0, 0, 100], [1, 0, 0]]);
  let full = rect(box, 2), half = rect(box, 0.5);
  near([half.l, half.t, half.r, half.b], [full.l, full.t + 25, full.l + 220, full.b - 25], 'Box Anchor Left: from the middle of the left edge');
  box.setEffect('Grow From', 3);
  near([rect(box, 0).w, rect(box, 0).h], [440, 100], 'Snap: there as the move starts');
  ({ box, title } = titleBox());
  slide(title, [[0, -500, 0], [1, 0, 0]]);
  full = rect(box, 2);
  half = rect(box, 0.5);
  near([half.l, half.t, half.r, half.b], [full.l, full.t, full.l + 220, full.b], 'from the left, for a layer coming from the left');
  ({ box, title } = titleBox());
  title.tprop('ADBE Anchor Point').s.value = [100, -30, 0];
  keys(title.tprop('ADBE Scale'), [[0, [0, 0, 100]], [1, [100, 100, 100]]]);
  full = rect(box, 2);
  half = rect(box, 0.5);
  const ax = full.l + 20 + 100, ay = full.t + 20 + 20; // the title's anchor in the box
  near([half.l, half.t, half.r, half.b], [(ax + full.l) / 2, (ay + full.t) / 2, (ax + full.r) / 2, (ay + full.b) / 2], 'from the point it scales from');
  ({ box, title } = titleBox());
  keys(title.tprop('ADBE Opacity'), [[1, 0], [2, 100]]);
  near(rect(box, 0.99).w, 0);
  near([rect(box, 1).w, rect(box, 1).h], [440, 100], 'a fade finds the box already there');
});

test('a layer on screen from the first frame that only leaves is in from the start', () => {
  const { box, title } = titleBox();
  slide(title, [[2, 0, 0, smooth], [2.5, 0, -150]]);
  for (const t of [0, 1, 2.2, 4]) near([rect(box, t).w, rect(box, t).h], [440, 100], `at ${t}`);
});

test('text swap: the incoming layer replaces the outgoing one on its own curve', () => {
  for (const lag of [0, 0.1, -0.1]) {
    const host = createHost();
    const comp = host.newComp({ duration: 10 });
    const b = comp.layers.addText('Second, much longer line', { position: [200, 300], rect: { left: 0, top: -50, width: 700, height: 60 } });
    const a = comp.layers.addText('First', { position: [200, 300], rect: { left: 0, top: -50, width: 300, height: 60 } });
    const box = create(host, comp, [a, b], { padding: 20, anchor: 5 });
    slide(a, [[0, 0, 100, smooth], [0.5, 0, 0], [2, 0, 0, smooth], [2.5, 0, -100]]);
    slide(b, [[2 + lag, 0, 100, smooth], [2.5 + lag, 0, 0]]);
    near(rect(box, 1).w, 340, `${lag}: A only`);
    near(rect(box, 2 + Math.min(lag, 0)).w, 340, `${lag}: still A as the swap starts`);
    const p = smooth(0.5);
    near(rect(box, 2.25 + lag).w, 340 + (740 - 340) * p, `${lag}: halfway on B's curve`);
    near(rect(box, 3).w, 740, `${lag}: B only, A is gone`);
  }
  // A static first line swapped out (on screen from frame 0, no entrance).
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const b = comp.layers.addText('B', { position: [200, 300], rect: { left: 0, top: -50, width: 300, height: 60 } });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -50, width: 700, height: 60 } });
  const box = create(host, comp, [a, b], { padding: 20, anchor: 1 });
  slide(a, [[2, 0, 0, smooth], [2.5, 0, -100]]);
  slide(b, [[0, 0, 100], [2, 0, 100, smooth], [2.5, 0, 0]]);
  near(rect(box, 1).w, 740, 'A is in from the start');
  near(rect(box, 2.25).w, 740 - 400 * smooth(0.5));
  near(rect(box, 3).w, 340);
});

test('a staggered list builds smoothly, each line on its own curve, and the box holds when they all leave', () => {
  const build = (gap, reverse) => {
    const host = createHost();
    const comp = host.newComp({ duration: 10 });
    const lines = [];
    for (let i = 3; i >= 0; i--) {
      lines.unshift(comp.layers.addText(`Line ${i}`, { position: [200, 300 + i * 50], rect: { left: 0, top: -40, width: 300 + i * 50, height: 40 } }));
    }
    if (reverse) lines.slice().reverse().forEach((l) => l.moveToBeginning());
    const box = create(host, comp, lines, { padding: 10, anchor: 1 });
    lines.forEach((l, i) => slide(l, [[i * gap, -600, 0, smooth], [i * gap + 0.4, 0, 0], [5, 0, 0], [5.4, 600, 0]]));
    return { box, lines };
  };
  // One after the other: the box fits each line as it lands.
  let { box } = build(0.5);
  for (let i = 0; i < 4; i++) {
    const t = i * 0.5 + 0.4;
    near([rect(box, t).w, rect(box, t).h], [320 + i * 50, 60 + i * 50], `line ${i} in`);
  }
  near([rect(box, 6).w, rect(box, 6).h], [470, 210], 'holds after they all leave');
  // Overlapping: no jumps, a landed line is never cut, and the layer order
  // doesn't change anything.
  const a = build(0.15), b = build(0.15, true);
  let prev = rect(a.box, 1 / 30);
  for (let f = 2; f <= 30; f++) {
    const t = f / 30, r = rect(a.box, t), r2 = rect(b.box, t);
    assert.ok(Math.abs(r.w - prev.w) < 60 && Math.abs(r.h - prev.h) < 25, `no jumps (frame ${f})`);
    near([r.l, r.t, r.r, r.b], [r2.l, r2.t, r2.r, r2.b], `same box whatever the layer order (frame ${f})`);
    a.lines.forEach((l, i) => {
      if (t < i * 0.15 + 0.4) return;
      const lb = l.compBounds(t), bb = a.box.boxCompBounds(t);
      assert.ok(lb.l >= bb.l - 1e-6 && lb.r <= bb.r + 1e-6 && lb.t >= bb.t - 1e-6 && lb.b <= bb.b + 1e-6, `line ${i} inside once landed (frame ${f})`);
    });
    prev = r;
  }
  near([rect(a.box, 1).w, rect(a.box, 1).h], [470, 210], 'all four in');
});

test('a layer that appears without keyframes: the box is ready over Morph Time, with Morph Ease', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.inPoint = 2;
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).h, 60, 'title only');
  near(rect(box, 1.75).h, 60 + 76 * 0.5, 'linear, halfway');
  near(rect(box, 2).h, 136, 'ready when it appears');
  box.setEffect('Morph Ease', 4);
  near(rect(box, 1.625).h, 60 + 76 * (4 * 0.25 * 0.25 * 0.25), 'ease in out');
  box.setEffect('Morph Time', 0);
  near(rect(box, 1.99).h, 60);
  near(rect(box, 2).h, 136, 'Morph Time 0 snaps');
});

test('a layer\'s out point takes it out (the box holds); the next layer in replaces it', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const b = comp.layers.addText('B', { position: [200, 300], rect: { left: 0, top: -50, width: 700, height: 60 }, inPoint: 4 });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -50, width: 300, height: 60 }, outPoint: 3 });
  const box = create(host, comp, [a, b], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).w, 300);
  near(rect(box, 3.4).w, 300, 'A is gone, the box holds');
  near(rect(box, 3.75).w, 500, 'gets ready for B');
  near(rect(box, 5).w, 700);
});

test('When Empty: Collapse shrinks the box away with the last layer out', () => {
  const { box, title } = titleBox({ whenEmpty: 2 });
  slide(title, [[0, 0, 100], [0.5, 0, 0], [3, 0, 0, smooth], [3.5, 0, -150]]);
  const full = rect(box, 2);
  const r = rect(box, 3.25), p = smooth(0.5);
  near([r.l, r.t, r.r, r.b], [full.l, full.t, full.r, full.b - 100 * p], 'shrinks toward the top, the way it leaves');
  near(rect(box, 4).h, 0);
});

test('moves that stay put (a nudge, a pulse, a slow drift) reposition the box; back-to-back keys stay separate', () => {
  let { box, title } = titleBox({ anchor: 1 });
  // in 0..0.5, nudge 60px right at 2..3, out 6..6.5
  slide(title, [[0, 0, 100], [0.5, 0, 0], [2, 0, 0, smooth], [3, 60, 0], [6, 60, 0], [6.5, 60, -200]]);
  const a = rect(box, 1);
  near(rect(box, 4).l - a.l, 60, 'follows the nudge');
  near(rect(box, 2.5).l - a.l, 60 * smooth(0.5), 'on its curve');
  near(rect(box, 7).l, a.l + 60, 'holds after the exit');
  // A pulse while in: the box breathes with it.
  ({ box, title } = titleBox());
  title.tprop('ADBE Anchor Point').s.value = [200, -20, 0];
  keys(title.tprop('ADBE Scale'), [[2, [100, 100, 100]], [2.2, [120, 120, 100]], [2.4, [100, 100, 100]]]);
  near(rect(box, 1).w, 440, 'in from the start: a pulse is no entrance');
  near(rect(box, 2.2).w, 520);
  near(rect(box, 3).w, 440);
  // A slow drift over the whole shot: in from the start, the box drifts along.
  ({ box, title } = titleBox({ anchor: 1 }));
  slide(title, [[0, 0, 0], [10, 120, 0]]);
  near(rect(box, 0).w, 440, 'not a 10-second entrance');
  near(rect(box, 5).l - rect(box, 0).l, 60);
  // Keys back to back: in 0..0.5, a push 0.5..3, out 3..3.5.
  ({ box, title } = titleBox({ anchor: 1 }));
  slide(title, [[0, 0, 100], [0.5, 0, 0], [3, 30, 0], [3.5, 30, -200]]);
  near([rect(box, 0.5).w, rect(box, 0.5).h], [440, 100], 'in after the slide, not after the whole chain');
  near(rect(box, 3).l - rect(box, 0.5).l, 30);
  near(rect(box, 4).l - rect(box, 0.5).l, 30, 'out at 3: holds');
});

test('a layer leaving while another is still coming in drops out of that morph', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const b = comp.layers.addText('B', { position: [200, 360], rect: { left: 0, top: -40, width: 200, height: 40 } });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -40, width: 600, height: 40 } });
  const box = create(host, comp, [a, b], { padding: 0, anchor: 1 });
  slide(a, [[0, 0, 100], [0.5, 0, 0], [2.8, 0, 0], [3.3, 0, -300]]);
  slide(b, [[1, 0, 300], [3, 0, 0]]);
  near(rect(box, 2).w, 600, 'A is still there: the box keeps it while B comes in');
  near(rect(box, 3.5).w, 200, 'B only, once A has gone');
  assert.ok(rect(box, 2.9).w < 600 && rect(box, 2.9).w > 200, 'refits on what is left of B\'s curve');
});

test('overshoot in a layer\'s curve can enlarge the box but never cut a layer', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const b = comp.layers.addText('B', { position: [200, 300], rect: { left: 0, top: -50, width: 200, height: 60 } });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -50, width: 600, height: 60 } });
  const box = create(host, comp, [a, b], { padding: 0, anchor: 1 });
  const back = (f) => 1 + 2.7 * Math.pow(f - 1, 3) + 1.7 * Math.pow(f - 1, 2); // easeOutBack
  slide(a, [[0, 0, 0], [2, 0, 0, smooth], [2.5, 0, -100]]);
  slide(b, [[0, 0, 100], [2, 0, 100, back], [2.6, 0, 0]]);
  for (let f = 60; f <= 80; f++) {
    const t = f / 30;
    assert.ok(rect(box, t).w >= 200 - 1e-6, `B (200 wide) never cut at ${t.toFixed(2)}`);
  }
});

test('overshoot in the layer\'s curve: a scale pop', () => {
  const { box, title } = titleBox();
  title.tprop('ADBE Anchor Point').s.value = [200, -20, 0];
  keys(title.tprop('ADBE Scale'), [[0, [0, 0, 100]], [0.3, [110, 110, 100]], [0.5, [100, 100, 100]]]);
  near(rect(box, 0.3).w, 400 * 1.1 + 40, 'fits the layer at its biggest');
  near(rect(box, 1).w, 440);
});

test('a hold-key jump in counts as coming in; the box is ready when it lands', () => {
  const { box, title } = titleBox({ anchor: 1, morphTime: 0.5, morphEase: 1 });
  slide(title, [[1, 0, 300, 'hold'], [2, 0, 0]]);
  near(rect(box, 1.4).w, 0, 'nothing yet');
  near([rect(box, 2).w, rect(box, 2).h], [440, 100], 'ready as it lands');
});

test('keyframed Source Text: the box makes room for the new text', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const title = comp.layers.addText('Title', {
    position: [200, 300], textKeys: [0, 2],
    rect: (t) => (t < 2 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 }),
  });
  const box = create(host, comp, [title], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).w, 400, 'a text change is no entrance');
  near(rect(box, 1.75).w, 500, 'grows ahead of the new text');
  near(rect(box, 2).w, 600);
  // Slid 1s along the timeline: still measured at the right time.
  title.startTime = 1;
  title.rect = (t) => (t < 3 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 });
  title.textKeys = [1, 3];
  near(rect(box, 2).w, 400);
  near(rect(box, 3).w, 600);
  // Shrinking text: the box waits for the change, then shrinks.
  title.startTime = 0;
  title.textKeys = [0, 2];
  title.rect = (t) => (t < 2 ? { left: 0, top: -50, width: 600, height: 60 } : { left: 0, top: -50, width: 400, height: 60 });
  near(rect(box, 1.9).w, 600);
  near(rect(box, 2.25).w, 500);
});

test('a text animator reveal drives the box, from the start of the line', () => {
  const { box, title } = titleBox({ anchor: 1 });
  const sel = title.addAnimator();
  keys(sel.end, [[1, 0, smooth], [2, 100]]);
  near(rect(box, 0.5).w, 0);
  const full = rect(box, 3), r = rect(box, 1.5);
  near([r.l, r.t, r.r, r.b], [full.l, full.t, full.l + 440 * smooth(0.5), full.b]);
});

test('layers moved by expressions are followed frame by frame', () => {
  const { box, title } = titleBox({ anchor: 1 });
  title.tprop('ADBE Position').s.expression = '[value[0] + time * 10, value[1]]';
  near(rect(box, 3).l - rect(box, 0).l, 30);
});

test('separated position dimensions, and riders (layers parented to a member)', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 1 });
  const pos = sub.tprop('ADBE Position');
  pos.dimensionsSeparated = true;
  const y = sub.tprop('ADBE Position_1').value;
  keys(sub.tprop('ADBE Position_1'), [[1, y + 300, smooth], [2, y]]);
  near(rect(box, 0.5).h, 60, 'subtitle not in yet');
  near(rect(box, 1.5).h, 60 + 76 * smooth(0.5));
  near(rect(box, 3).h, 136);
  // A rider moves with its parent, and is only in while its parent is.
  const icon = comp.layers.addShapeMember('Icon', { position: [0, 0], rect: { left: 0, top: 0, width: 20, height: 20 } });
  icon.parent = sub;
  icon.tprop('ADBE Position').s.value = [-60, -30, 0];
  near(rect(box, 3).l, -40, 'icon sticks out left of the subtitle');
  near(rect(box, 0.5).l, 0, 'not before its parent comes in');
  // A rider with its own entrance comes in on that, not before.
  keys(icon.tprop('ADBE Position'), [[2.5, [900, -30, 0], smooth], [3, [-60, -30, 0]]]);
  near(rect(box, 2.2).l, 0, 'waiting off to the right: not in yet');
  near(rect(box, 3.5).l, -40);
});

test('Ignore Hidden: a layer with its video switched off does not count', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { padding: 0 });
  sub.enabled = false;
  near(rect(box, 1).h, 60);
  box.setEffect('Ignore Hidden', 0);
  near(rect(box, 1).h, 136);
});

test('Smart Animate off: the box follows its layers every frame', () => {
  const { box, title } = titleBox({ anchor: 1, smartAnimate: 0 });
  slide(title, [[1, 0, 200], [2, 0, 0], [3, 0, 0], [4, 300, 0]]);
  const at = (t) => rect(box, t);
  near(at(0.5).t - at(2).t, 200, 'wraps the layer where it is');
  near(at(3.5).l - at(2).l, 150);
});

test('In Box: Out never counts, In from a key borrows the move, Out again holds, Skip passes to children', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  comp.select(sub);
  host.api.addInBoxToggles();
  const menu = sub.effectsState.children.find((e) => e.name === 'In Box');
  assert.deepEqual(menu.children[0].items, ['Auto', 'In', 'Out', 'Skip']);
  const ib = menu.children[0];
  near(rect(box, 1).h, 136, 'Auto: as before');
  ib.value = 3;
  near(rect(box, 1).h, 60, 'Out: never changes the box');
  // Slides in at 2..3 but counts from 2.5: the rest of the slide's curve.
  const home = sub.tprop('ADBE Position').valueAtTime(0, true);
  const pos = sub.tprop('ADBE Position');
  const below = [home[0], home[1] + 200, home[2]];
  keys(pos, [[2, below], [3, home]]);
  keys(ib, [[0, 3], [2.5, 2], [6, 3]]);
  near(rect(box, 2.4).h, 60);
  near(rect(box, 2.75).h, 60 + 76 * 0.5, 'halfway through what is left');
  near(rect(box, 4).h, 136);
  near(rect(box, 7).h, 136, 'Out again: the box holds');
  // In a little before the move: waits for it.
  keys(ib, [[0, 3], [1.8, 2]]);
  near(rect(box, 1.9).h, 60);
  near(rect(box, 2.5).h, 98);
  // No move at all: Morph Time, ready by the switch.
  keys(pos, []);
  pos.s.value = home;
  keys(ib, [[0, 3], [4, 2]]);
  near(rect(box, 3.75).h, 98);
  near(rect(box, 4).h, 136);
  // In without keys: in from the start, measured where it settles.
  keys(pos, [[2, below], [3, home]]);
  keys(ib, []);
  ib.value = 2;
  near(rect(box, 1).h, 136);
  // Skip: the layer doesn't count, the ones parented to it do.
  const dot = comp.layers.addShapeMember('Dot', { rect: { left: 0, top: 0, width: 10, height: 10 } });
  dot.parent = sub;
  dot.tprop('ADBE Position').s.value = [0, 0, 0]; // on the subtitle's baseline
  ib.value = 4;
  near(rect(box, 4).h, 140, 'the title and the dot, not the subtitle');
  comp.select(sub);
  host.api.addInBoxToggles();
  assert.match(host.alerts.pop(), /already has In Box/);
});

test('nulls and adjustment layers in a box are set to Skip', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { padding: 0 });
  const ctrl = comp.layers.addNull({ name: 'Ctrl', position: [900, 900] });
  ctrl.parent = box;
  comp.select(box);
  host.api.applySettings(settings(host, { padding: 0 }));
  const menu = ctrl.effectsState.children.find((e) => e.name === 'In Box');
  near(menu.children[0].value, 4);
  near(rect(box, 1).w, 400, 'the null takes no space');
});

test('Freeze holds the box, then eases back; Freeze with no keys locks the settled box', () => {
  const { box, title } = titleBox({ anchor: 1, morphTime: 0.5, morphEase: 1 });
  const freeze = box.effectsState.children.find((e) => e.name === 'Freeze').children[0];
  title.textKeys = [0, 2];
  title.rect = (t) => (t < 2 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 });
  keys(freeze, [[0, 0], [1, 1], [3, 0]]);
  near(rect(box, 2.6).w, 440, 'frozen at its 1s shape');
  near(rect(box, 3.25).w, 440 + 200 * 0.5, 'eases back over Morph Time');
  near(rect(box, 4).w, 640);
  // Two runs close together: no jump.
  keys(freeze, [[0, 0], [1, 1], [2.1, 0], [2.3, 1], [3, 0]]);
  let prev = rect(box, 2).w;
  for (let f = 61; f <= 100; f++) {
    const w = rect(box, f / 30).w;
    assert.ok(Math.abs(w - prev) < 40, `no jump at frame ${f}`);
    prev = w;
  }
  // Frozen from the start: holds the shape it has when Freeze turns off.
  keys(freeze, [[0, 1], [2.5, 0]]);
  near(rect(box, 0.5).w, 640);
  // No keys: the box is locked at its settled shape.
  slide(title, [[1, 0, 200], [1.5, 0, 0]]);
  keys(freeze, []);
  freeze.value = 1;
  for (const t of [0, 1.2, 5]) near(rect(box, t).w, 640, `locked at ${t}`);
});

test('nested boxes: the outer box fits the inner one through its layers, on their curves', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 100, height: 36 } });
  const icon = comp.layers.addShapeMember('Icon', { position: [200, 280], rect: { left: 0, top: -40, width: 40, height: 40 } });
  const title = comp.layers.addText('Title', { position: [260, 280], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const inner = create(host, comp, [icon, title], { padding: 10, anchor: 1, strokeWidth: 4 });
  const outer = create(host, comp, [inner, sub], { padding: 20, anchor: 1 });
  assert.equal(inner.parent, outer);
  assert.equal(icon.parent, inner);
  const ib = inner.boxCompBounds(1), ob = outer.boxCompBounds(1);
  near([ob.l, ob.t, ob.r], [ib.l - 2 - 20, ib.t - 2 - 20, ib.r + 2 + 20], 'outer = inner + its stroke + padding');
  // The title slides into the inner box: both boxes grow on its curve.
  slide(title, [[1, 0, 100, smooth], [2, 0, 0]]);
  const iw = (t) => inner.boxRect(t).w, ow = (t) => outer.boxRect(t).w;
  near((ow(1.5) - ow(1)) / (ow(2) - ow(1)), (iw(1.5) - iw(1)) / (iw(2) - iw(1)), 'on the same curve');
  near(ow(2) - iw(2), 44);
  for (const l of [inner, outer]) {
    for (const mn of ['ADBE Vector Rect Size', 'ADBE Vector Rect Position']) assert.equal(item(l, 'Box Rect')(mn).s.expressionError, '');
  }
  // An empty inner box adds nothing.
  title.remove();
  icon.remove();
  near(outer.boxRect(1).w, 140, 'just the subtitle');
});

test('scaled members and a rotated, scaled box: measured in the box\'s own space', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.remove();
  title.tprop('ADBE Scale').s.value = [50, 50, 100];
  const box = create(host, comp, [title], { padding: 10, anchor: 1 });
  near([rect(box, 0).w, rect(box, 0).h], [220, 50]);
  box.tprop('ADBE Rotate Z').s.value = 30;
  box.tprop('ADBE Scale').s.value = [200, 200, 100];
  near([rect(box, 0).w, rect(box, 0).h], [220, 50], 'the box\'s own transform doesn\'t change its rect');
});

test('tracking data (dense keyframes) is followed frame by frame', () => {
  const { box, title } = titleBox({ anchor: 1 });
  const home = title.tprop('ADBE Position').valueAtTime(0, true);
  const list = [];
  for (let f = 0; f <= 60; f++) list.push([f / 30, [home[0] + 40 * Math.sin(f / 5), home[1], 0]]);
  keys(title.tprop('ADBE Position'), list);
  for (const t of [0, 0.5, 1.2, 2]) {
    const lb = title.compBounds(t), bb = box.boxCompBounds(t);
    near(bb.l, lb.l - 20, `wraps it at ${t}`);
  }
});

test('Matte: skips nulls, asks before replacing another matte, covers its layers\' time, notes what shapes the matte', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { fillOpacity: 70 });
  const ctrl = comp.layers.addNull({ name: 'Ctrl' });
  ctrl.parent = box;
  const other = comp.layers.addSolid('Other');
  sub.setTrackMatte(other, TRACK_MATTE.LUMA);
  sub.outPoint = 15;
  comp.select(box);
  host.confirmAnswer = false;
  host.api.matteBoxes();
  assert.match(host.confirms.pop(), /already use another layer[\s\S]*Subtitle \(uses Other\)/);
  assert.equal(title.trackMatteLayer, null, 'declined: nothing changed');
  host.confirmAnswer = true;
  host.api.matteBoxes();
  assert.equal(sub.trackMatteLayer, box);
  assert.equal(ctrl.trackMatteLayer, null, 'the null gets no matte');
  assert.equal(box.outPoint, 15, 'the box lasts as long as its layers');
  assert.match(host.alerts.pop(), /its Fill Opacity/);
  // Stroke only.
  comp.select(box);
  host.api.matteBoxes();
  item(box, 'Fill')('ADBE Vector Fill Opacity').s.value = 100;
  new Prop(items(box).find((c) => c.name === 'Fill')).enabled = false;
  host.api.matteBoxes();
  assert.match(host.alerts.pop(), /no fill, so its layers only show under its stroke/);
});

test('one Apply converts several old boxes', () => {
  const host = createHost();
  const old = oldApi('AutoBox-2.0.1.jsx');
  const comp = host.newComp();
  const b = comp.layers.addText('B', { position: [200, 600], rect: { left: 0, top: -50, width: 300, height: 60 } });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -50, width: 300, height: 60 } });
  comp.select(a);
  old.createBox(Object.assign({}, old.DEFAULTS, { strokeWidth: 2 }));
  comp.select(b);
  old.createBox(Object.assign({}, old.DEFAULTS, { strokeWidth: 2 }));
  const boxes = comp._layers.filter((l) => /^AutoBox \d$/.test(l.name));
  assert.equal(boxes.length, 2);
  comp.select(...boxes);
  host.api.applySettings(settings(host));
  assert.match(host.alerts.pop(), /Converted to AutoBox 3[\s\S]*AutoBox 1[\s\S]*AutoBox 2|Converted to AutoBox 3[\s\S]*AutoBox 2[\s\S]*AutoBox 1/);
  for (const bx of boxes) assert.ok(bx.effectsState.children.some((e) => e.name === 'Smart Animate'), `${bx.name} converted`);
  assert.equal(comp._layers.filter((l) => /Stroke$/.test(l.name)).length, 0);
});

test('converting a 2.x stack bakes positions that changed over time', () => {
  const host = createHost();
  const old = oldApi('AutoBox-2.0.1.jsx');
  const comp = host.newComp();
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', {
    position: [200, 300], rect: (t) => (t < 2 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -100, width: 400, height: 110 }),
  });
  comp.select(title, sub);
  old.createBox(Object.assign({}, old.DEFAULTS, { layout: 2, gap: 10 }));
  const box = comp.layer('AutoBox 1');
  const before = [0, 3].map((t) => sub.compBounds(t));
  comp.select(box);
  host.api.applySettings(settings(host));
  [0, 3].forEach((t, i) => bounds(sub.compBounds(t), ...Object.values(before[i]), `subtitle in place at ${t}`));
  assert.ok(sub.tprop('ADBE Position').numKeys > 0, 'keyed where the stack moved it');
});

test('Release stops on a broken expression instead of changing the box', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  const size = item(box, 'Box Rect')('ADBE Vector Rect Size');
  size.s.expression = 'thisComp.layer("Nope").position;';
  comp.select(box);
  host.confirmAnswer = true;
  host.api.releaseBoxes();
  assert.match(host.alerts.pop(), /expression has an error, so Release would change its shape/);
  assert.ok(box.effectsState.children.length > 0, 'nothing released');
});

test('the box has no motion blur of its own', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  assert.equal(box.motionBlur, false);
});

// ---------------------------------------------------------------------------
// Smart Animate: cases from the final review
// ---------------------------------------------------------------------------
// How far a layer sticks out of the box at t (0: inside).
function cut(box, layer, t) {
  const b = box.boxCompBounds(t), l = layer.compBounds(t);
  return Math.max(0, b.l - l.l, l.r - b.r, b.t - l.t, l.b - b.b);
}
// A jump: an edge moving much further in one frame than in the frames
// around it, over [a, b]. Returns the biggest one (0: none).
function jumps(box, a, b) {
  const R = [];
  for (let f = Math.round(a * 30); f <= Math.round(b * 30); f++) R.push(rect(box, f / 30));
  const step = (i) => (R[i].w <= 0.01 || R[i - 1].w <= 0.01 ? 0
    : Math.max(Math.abs(R[i].l - R[i - 1].l), Math.abs(R[i].r - R[i - 1].r), Math.abs(R[i].t - R[i - 1].t), Math.abs(R[i].b - R[i - 1].b)));
  let worst = 0;
  for (let i = 2; i < R.length - 1; i++) {
    const d = step(i);
    if (d > 25 && d > 4 * Math.max(step(i - 1), step(i + 1))) worst = Math.max(worst, d);
  }
  return worst;
}
// Biggest frame-to-frame move of any edge while the box shows, over [a, b].
function maxStep(box, a, b) {
  let prev = null, worst = 0;
  for (let f = Math.round(a * 30); f <= Math.round(b * 30); f++) {
    const r = rect(box, f / 30), vis = r.w > 0.01 && r.h > 0.01;
    if (prev && vis) worst = Math.max(worst, Math.abs(r.l - prev.l), Math.abs(r.r - prev.r), Math.abs(r.t - prev.t), Math.abs(r.b - prev.b));
    prev = vis ? r : null;
  }
  return worst;
}
function textComp(host, list, duration = 10) {
  const comp = host.newComp({ duration });
  const out = {};
  list.slice().reverse().forEach(([name, x, y, w, h, o]) => {
    out[name] = comp.layers.addText(name, Object.assign({ position: [x, y], rect: { left: 0, top: -h + 10, width: w, height: h } }, o));
  });
  return { comp, L: out };
}

test('a fade, scale or axis shorter than the slide it comes with: fitted where the layer settles', () => {
  for (const kind of ['fade', 'scale', 'axis']) {
    const host = createHost();
    const { comp, L } = textComp(host, [['Title', 200, 300, 400, 60]]);
    const t = L.Title;
    const box = create(host, comp, [t], { padding: 20, anchor: 1 });
    if (kind === 'axis') {
      t.tprop('ADBE Position').dimensionsSeparated = true;
      keys(t.tprop('ADBE Position_0'), [[0, -700, smooth], [0.4, 200]]);
      keys(t.tprop('ADBE Position_1'), [[0, 700, smooth], [0.8, 300]]);
    } else {
      slide(t, [[0, 0, 400, smooth], [0.667, 0, 0]]);
      if (kind === 'fade') keys(t.tprop('ADBE Opacity'), [[0, 0], [0.2, 100]]);
      else keys(t.tprop('ADBE Scale'), [[0, [0, 0, 100]], [0.2, [100, 100, 100]]]);
    }
    for (const at of [1, 3]) near(cut(box, t, at), 0, `${kind}: inside at ${at}`);
  }
});

test('an out point takes a layer out even when the next one is elsewhere; Collapse shrinks at the out point', () => {
  for (const whenEmpty of [1, 2]) {
    const host = createHost();
    const { comp, L } = textComp(host, [['A', 200, 300, 700, 60, { outPoint: 3 }], ['B', 200, 500, 300, 60, { inPoint: 4 }]]);
    const box = create(host, comp, [L.A, L.B], { padding: 0, anchor: 1, whenEmpty });
    near(rect(box, 1).w, 700);
    if (whenEmpty === 1) near(rect(box, 3.5).w, 700, 'held');
    else near(rect(box, 3.5).w, 0, 'collapsed');
    for (const t of [5, 8]) near([rect(box, t).w, rect(box, t).h], [300, 60], `B only at ${t}`);
  }
});

test('an entrance through a middle key (two legs, an arc) ends fitted where the layer lands', () => {
  for (const legs of [[[0, -900, 0, smooth], [0.3, -400, 0, smooth], [0.6, 0, 0]], [[0, -600, 300, smooth], [0.4, -300, -80, smooth], [0.8, 0, 0]]]) {
    const host = createHost();
    const { comp, L } = textComp(host, [['Title', 600, 300, 400, 60]]);
    const box = create(host, comp, [L.Title], { padding: 20, anchor: 1 });
    slide(L.Title, legs);
    for (const t of [1, 3]) near(cut(box, L.Title, t), 0, `inside at ${t}`);
  }
});

test('a layer whose head is trimmed past its keys is in from its in point', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['A', 200, 300, 700, 60, { inPoint: 2 }], ['Sub', 200, 400, 300, 36]]);
  const box = create(host, comp, [L.A, L.Sub], { padding: 0, anchor: 1 });
  slide(L.A, [[0, 0, 300, smooth], [0.5, 0, 0]]);
  near(rect(box, 1).w, 300, 'not yet');
  for (const t of [2, 3, 6]) near(cut(box, L.A, t), 0, `in at ${t}`);
});

test('a layer that lands before a slower one is never cut', () => {
  // A layer without keys appearing while another slides in slowly.
  let host = createHost();
  let { comp, L } = textComp(host, [['C', 200, 300, 200, 44], ['A', 200, 380, 600, 44], ['B', 200, 460, 400, 44, { inPoint: 1.2 }]], 8);
  let box = create(host, comp, [L.C, L.A, L.B], { padding: 10, anchor: 1 });
  slide(L.A, [[1, -900, 0, smooth], [1.6, 0, 0]]);
  for (const t of [1.2, 1.3, 1.4, 2]) near(cut(box, L.B, t), 0, `B inside at ${t}`);
  near(jumps(box, 0.5, 2), 0, 'no jumps');
  // A fast line landing under a slow one.
  host = createHost();
  ({ comp, L } = textComp(host, [['Line 0', 200, 300, 600, 44], ['Line 1', 200, 370, 300, 44]], 8));
  box = create(host, comp, [L['Line 0'], L['Line 1']], { padding: 10, anchor: 1 });
  slide(L['Line 0'], [[0, -900, 0, smooth], [1.2, 0, 0]]);
  slide(L['Line 1'], [[0.2, -900, 0, smooth], [0.4, 0, 0]]);
  for (const t of [0.4, 0.5, 0.6, 0.8]) near(cut(box, L['Line 1'], t), 0, `Line 1 inside at ${t}`);
});

test('a list rising into place line by line (a matte reveal) fits every line', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 8 });
  const lines = [];
  for (let i = 4; i >= 0; i--) lines.unshift(comp.layers.addText(`Line ${i}`, { position: [700, 300 + i * 70], rect: { left: 0, top: -40, width: 300 + i * 40, height: 44 } }));
  const box = create(host, comp, lines, { padding: 16, anchor: 1 });
  lines.forEach((l, i) => slide(l, [[0.2 + i * 0.4, 0, 60, smooth], [0.6 + i * 0.4, 0, 0]]));
  near(rect(box, 0.1).w, 0, 'nothing in before the first line rises');
  lines.forEach((l, i) => {
    for (const t of [0.61 + i * 0.4, 3, 5]) near(cut(box, l, t), 0, `line ${i} at ${t}`);
  });
});

test('nothing shows before the first layer comes in, even when a later one gets ready early', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['A', 200, 300, 500, 60], ['B', 200, 400, 300, 36, { inPoint: 1.2 }]]);
  const box = create(host, comp, [L.A, L.B], { padding: 10, anchor: 1, morphTime: 0.4 });
  slide(L.A, [[1, -600, 0, smooth], [1.5, 0, 0]]);
  for (let f = 0; f <= 30; f++) near(rect(box, f / 30).w, 0, `hidden at frame ${f}`);
  assert.ok(rect(box, 1.1).w > 0);
  near(jumps(box, 1, 2), 0, 'grows without jumps');
  near(cut(box, L.B, 1.2), 0, 'ready when B appears');
});

test('Collapse, then a new layer: it grows where the new layer is, without jumps', () => {
  // B appears elsewhere long after; B slides into the same spot while the box is still collapsing.
  let host = createHost();
  let { comp, L } = textComp(host, [['A', 200, 300, 500, 60], ['B', 900, 700, 300, 60, { inPoint: 5 }]]);
  let box = create(host, comp, [L.A, L.B], { padding: 20, anchor: 5, whenEmpty: 2 });
  slide(L.A, [[2, 0, 0, smooth], [2.5, -900, 0]]);
  near(rect(box, 3).w, 0, 'collapsed');
  const at47 = box.boxCompBounds(4.7);
  assert.ok(at47.l > 700 && at47.t > 500, 'grows around B, not where A was');
  near(cut(box, L.B, 5), 0);
  near(jumps(box, 0, 7), 0, 'no jumps');
  host = createHost();
  ({ comp, L } = textComp(host, [['A', 700, 500, 500, 60], ['B', 700, 500, 500, 60]], 8));
  box = create(host, comp, [L.A, L.B], { padding: 20, anchor: 1, whenEmpty: 2 });
  slide(L.A, [[2, 0, 0, smooth], [2.5, 0, -400]]);
  slide(L.B, [[0, 0, 400], [2.2, 0, 400, smooth], [2.7, 0, 0]]);
  assert.ok(maxStep(box, 2, 3) < 25, 'picks up from the collapsing box');
  near(cut(box, L.B, 3), 0);
});

test('typewriter: an animator that hides text tells when it shows; erasing takes it out', () => {
  // On screen from frame 0, erased at 3..4 by an Opacity 0 animator (Start 100 -> 0 selects more).
  let host = createHost();
  let { comp, L } = textComp(host, [['Title', 200, 300, 400, 60]]);
  let box = create(host, comp, [L.Title], { padding: 20, anchor: 1 });
  keys(L.Title.addAnimator({ opacity: 0 }).start, [[0, 100], [3, 100], [4, 0]]);
  for (const t of [0, 1, 2.9]) near(rect(box, t).w, 440, `in from the start (${t})`);
  // A types on and off, then B types on in the same spot: the box goes from A's size to B's.
  host = createHost();
  ({ comp, L } = textComp(host, [['A', 200, 300, 700, 60], ['B', 200, 300, 300, 60]]));
  box = create(host, comp, [L.A, L.B], { padding: 0, anchor: 1 });
  keys(L.A.addAnimator({ opacity: 0 }).start, [[0, 0], [1, 100], [2, 100], [3, 0]]);
  keys(L.B.addAnimator({ opacity: 0 }).start, [[0, 0], [3, 0], [4, 100]]);
  near(rect(box, 0).w, 0, 'nothing typed yet');
  near(rect(box, 1.5).w, 700);
  near(rect(box, 5).w, 300);
  // Without a hiding animator, a reveal that runs back takes it out too.
  host = createHost();
  ({ comp, L } = textComp(host, [['A', 200, 300, 700, 60], ['B', 200, 300, 300, 60]]));
  box = create(host, comp, [L.A, L.B], { padding: 0, anchor: 1 });
  keys(L.A.addAnimator().end, [[0, 0], [1, 100], [2, 100], [3, 0]]);
  keys(L.B.addAnimator().end, [[3, 0], [4, 100]]);
  near(rect(box, 5).w, 300);
});

test('a layer leaving while an overshooting entrance is under way still refits the box', () => {
  const back = (f) => 1 + 2.7 * Math.pow(f - 1, 3) + 1.7 * Math.pow(f - 1, 2);
  for (const ease of [smooth, back]) {
    const host = createHost();
    const { comp, L } = textComp(host, [['A', 700, 500, 700, 60], ['B', 700, 500, 300, 60]], 8);
    const box = create(host, comp, [L.A, L.B], { padding: 20, anchor: 1 });
    slide(L.B, [[0, 0, 300], [1.8, 0, 300, ease], [2.4, 0, 0]]);
    slide(L.A, [[2.1, 0, 0, smooth], [2.4, 0, -300]]);
    near(rect(box, 5).w, 340);
  }
  // B pops in (no curve to follow) just before A leaves.
  const host = createHost();
  const { comp, L } = textComp(host, [['A', 700, 500, 700, 60], ['B', 700, 500, 300, 60]], 8);
  const box = create(host, comp, [L.A, L.B], { padding: 20, anchor: 1 });
  slide(L.B, [[0, 0, 2000, 'hold'], [1.8, 0, 0]]);
  slide(L.A, [[2, 0, 0, smooth], [2.3, 0, -300]]);
  near(rect(box, 5).w, 340);
  near(jumps(box, 1.5, 3), 0, 'no jumps');
});

test('layers coming in together: the same box whatever their order in the timeline', () => {
  const easeOut = (f) => 1 - Math.pow(1 - f, 3);
  const build = (reverse) => {
    const host = createHost();
    const { comp, L } = textComp(host, [['Title', 200, 300, 300, 60], ['Sub', 200, 380, 600, 36]]);
    if (reverse) L.Sub.moveToBeginning();
    const box = create(host, comp, [L.Title, L.Sub], { padding: 10, anchor: 1 });
    slide(L.Title, [[0.5, -800, 0, easeOut], [1, 0, 0]]);
    slide(L.Sub, [[0.5, 800, 0], [1, 0, 0]]);
    return box;
  };
  const a = build(false), b = build(true);
  for (let f = 15; f <= 30; f++) {
    const r1 = rect(a, f / 30), r2 = rect(b, f / 30);
    near([r1.l, r1.t, r1.r, r1.b], [r2.l, r2.t, r2.r, r2.b], `frame ${f}`);
  }
});

test('wiggler keys: the box covers every one of them; Source Text keys still reshape it', () => {
  let host = createHost();
  let { comp, L } = textComp(host, [['Title', 600, 300, 400, 60]]);
  let box = create(host, comp, [L.Title], { padding: 20, anchor: 1 });
  const list = [];
  for (let k = 0; k < 20; k++) list.push([1 + k * 0.1, k === 2 ? 70 : (k % 2 ? -20 : 20), 0]);
  slide(L.Title, list);
  for (let f = 0; f <= 120; f += 3) near(cut(box, L.Title, f / 30), 0, `frame ${f}`);
  host = createHost();
  comp = host.newComp({ duration: 10 });
  const times = [];
  for (let k = 0; k < 16; k++) times.push(1 + k / 15);
  const title = comp.layers.addText('Title', { position: [200, 300], textKeys: [0].concat(times),
    rect: (t) => ({ left: 0, top: -50, width: 30 * times.filter((tk) => t >= tk).length + 1, height: 60 }) });
  box = create(host, comp, [title], { padding: 10, anchor: 1 });
  assert.ok(rect(box, 0.5).w < 30, 'follows the typing');
  for (const t of [1.5, 3, 5]) near(cut(box, title, t), 0, `at ${t}`);
});

test('an expression on top of keyframes is followed too', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Title', 600, 300, 400, 60]]);
  const box = create(host, comp, [L.Title], { padding: 20, anchor: 1 });
  slide(L.Title, [[0, 0, 300, smooth], [0.5, 0, 0]]);
  L.Title.tprop('ADBE Position').s.expression = '[value[0] + 60 * Math.sin(time * 3), value[1]]';
  for (let f = 15; f <= 300; f += 7) near(cut(box, L.Title, f / 30), 0, `frame ${f}`);
});

test('Freeze with no keys holds the box as it is at the end, whatever the current time', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Title', 600, 300, 400, 60]]);
  const box = create(host, comp, [L.Title], { padding: 20, anchor: 1 });
  L.Title.tprop('ADBE Position').s.expression = '[value[0] + time * 10, value[1]]';
  box.setEffect('Freeze', 1);
  const end = rect(box, 10);
  assert.ok(Math.abs(end.l - 100) < 1, `near the layer's last place (${end.l})`);
  for (const t of [0, 5]) near([rect(box, t).l, rect(box, t).w], [end.l, end.w], `same at ${t}`);
});

test('a layer keyed to Skip still lets the layers parented to it count; a camera on the way up is ignored', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Title', 200, 300, 400, 60], ['Subtitle', 220, 380, 300, 36], ['C', 200, 600, 100, 36]]);
  const box = create(host, comp, [L.Title, L.Subtitle, L.C], { padding: 0, anchor: 1 });
  slide(L.C, [[4, 0, 400, smooth], [4.5, 0, 0]]);
  const dot = comp.layers.addShapeMember('Dot', { rect: { left: 0, top: 0, width: 10, height: 10 } });
  dot.parent = L.Subtitle;
  dot.tprop('ADBE Position').s.value = [-100, 0, 0];
  comp.select(L.Subtitle);
  host.api.addInBoxToggles();
  const ib = L.Subtitle.effectsState.children.find((e) => e.name === 'In Box').children[0];
  keys(ib, [[0, 1], [2, 4]]);
  near(cut(box, dot, 5), 0, 'the dot still counts');
  const cam = comp.layers.addCamera('Camera 1');
  cam.parent = box;
  const label = comp.layers.addText('Label', { position: [0, 0], rect: { left: 0, top: -20, width: 100, height: 24 } });
  label.parent = cam;
  near(cut(box, L.Title, 5), 0);
  assert.deepEqual(box.rectShapes()[0].children.map((c) => c.expressionError).filter(Boolean), []);
});

test('a layer on screen at its in point that moves away at once was in', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['A', 700, 500, 500, 60], ['B', 700, 500, 300, 60]]);
  const box = create(host, comp, [L.A, L.B], { padding: 20, anchor: 1 });
  slide(L.A, [[0, 0, 0, smooth], [0.5, -1400, 0]]);
  slide(L.B, [[1, 0, 300, smooth], [1.5, 0, 0]]);
  near(rect(box, 0).w, 540, 'around A');
  near(rect(box, 0.4).w, 540, 'holds while A leaves');
  near(rect(box, 2).w, 340, 'then B');
});

// ---------------------------------------------------------------------------
// Panel actions: cases from the final review
// ---------------------------------------------------------------------------
test('Remove takes its box off as the layer\'s matte, keeps an outer box, and Matte off clears leftovers', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const icon = comp.layers.addShapeMember('Icon', { position: [150, 280], rect: { left: 0, top: -30, width: 30, height: 30 } });
  const inner = create(host, comp, [icon, title]);
  const outer = create(host, comp, [inner, sub], { padding: 20 });
  comp.select(inner);
  host.api.matteBoxes();
  assert.equal(title.trackMatteLayer, inner);
  comp.select(title);
  host.api.removeFromBox();
  assert.equal(title.parent, outer, 'still in the outer box');
  assert.equal(title.trackMatteLayer, null, 'no longer matted to the box it left');
  near(cut(outer, title, 1), 0, 'the outer box still fits it');
  // A layer taken out by hand: Matte off clears it too.
  const host2 = createHost();
  const s2 = scene(host2);
  const box = create(host2, s2.comp, [s2.title, s2.sub]);
  s2.comp.select(box);
  host2.api.matteBoxes();
  s2.sub.parent = null;
  assert.equal(s2.sub.trackMatteLayer, box);
  s2.comp.select(box);
  host2.api.matteBoxes();
  assert.equal(s2.title.trackMatteLayer, null);
  assert.equal(s2.sub.trackMatteLayer, null);
});

test('Matte on several boxes: one click turns them all on (or all off)', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const a = create(host, comp, [title]);
  const b = create(host, comp, [sub]);
  comp.select(a);
  host.api.matteBoxes();
  host.alerts.length = 0;
  comp.select(a, b);
  host.api.matteBoxes();
  assert.equal(title.trackMatteLayer, a);
  assert.equal(sub.trackMatteLayer, b);
  comp.select(a, b);
  host.api.matteBoxes();
  assert.equal(title.trackMatteLayer, null);
  assert.equal(sub.trackMatteLayer, null);
});

test('Matte notes a see-through gradient fill', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillType: 2, fillOpacity: 40 });
  comp.select(box);
  host.api.matteBoxes();
  const note = host.alerts.pop();
  assert.match(note, /Gradient Fill Opacity/);
  assert.match(note, /color stops/);
});

test('Release of a nested box: the outer box still wraps it', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const icon = comp.layers.addShapeMember('Icon', { position: [150, 280], rect: { left: 0, top: -30, width: 30, height: 30 } });
  const inner = create(host, comp, [icon, title], { padding: 30, strokeWidth: 4 });
  const outer = create(host, comp, [inner, sub], { padding: 20 });
  const before = outer.boxCompBounds(1);
  comp.select(inner);
  host.confirmAnswer = true;
  host.api.releaseBoxes();
  const after = outer.boxCompBounds(1);
  near([after.l, after.t, after.r, after.b], [before.l, before.t, before.r, before.b]);
});

test('a rectangle of your own in the box\'s group is left alone, and Release bakes the box\'s own', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  const contents = box.contentsState.children.find((c) => c.name === 'AutoBox').children[0];
  const tab = new Prop(contents).addProperty('ADBE Vector Shape - Rect');
  tab.name = 'Tab';
  tab.property('ADBE Vector Rect Size').setValue([80, 20]);
  const s = contents.children.pop();
  contents.children.unshift(s);
  comp.select(box);
  host.api.applySettings(settings(host, { padding: 10 }));
  near(tab.property('ADBE Vector Rect Size').value, [80, 20], 'untouched');
  assert.equal(tab.property('ADBE Vector Rect Size').expression, '');
  host.confirmAnswer = true;
  comp.select(box);
  host.api.releaseBoxes();
  assert.deepEqual(expressions(comp), []);
});

test('a keyframed stroke width keeps the stroke on (Apply, and converting an old box with hold keys)', () => {
  let host = createHost();
  let { comp, title, sub } = scene(host);
  let box = create(host, comp, [title, sub], { strokeWidth: 4 });
  keys(item(box, 'Stroke')('ADBE Vector Stroke Width'), [[1, 0], [2, 8]]);
  comp.select(box);
  host.api.applySettings(settings(host, { strokeWidth: 0 }));
  assert.ok(enabled(box).includes('Stroke'), 'still on');
  // A 2.0.1 box: Stroke Width keyed 0 -> 6, Corner Radius held at 0 until 2s.
  host = createHost();
  ({ comp, title, sub } = scene(host));
  const old = oldApi('AutoBox-2.0.1.jsx');
  globalThis.AUTOBOX_TEST = {};
  comp.select(title, sub);
  old.createBox(Object.assign({}, old.DEFAULTS));
  box = comp._layers.find((l) => l.name.indexOf('AutoBox') === 0 && !/Stroke/.test(l.name));
  const ctl = (name) => box.effectsState.children.find((e) => e.name === name).children[0];
  keys(ctl('Stroke Width'), [[1, 0], [2, 6]]);
  keys(ctl('Corner Radius'), [[0, 0, 'hold'], [2, 30]]);
  comp.time = 0;
  comp.select(box);
  host.confirmAnswer = true;
  host.api.applySettings(settings(host));
  assert.ok(enabled(box).includes('Stroke'), 'converted stroke is on');
  near(item(box, 'Stroke')('ADBE Vector Stroke Width').valueAtTime(3, false), 6);
  near(new Prop(items(box).find((c) => c.name === 'Box Rect').children[2]).valueAtTime(1, false), 0, 'hold key kept');
});

test('In Box is for layers, not boxes', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const inner = create(host, comp, [title]);
  create(host, comp, [inner, sub]);
  comp.select(inner);
  host.api.addInBoxToggles();
  assert.match(host.alerts.pop(), /it's a box/);
  assert.ok(!inner.effectsState.children.some((e) => e.name === 'In Box'));
});

test('Add to Box and Matte only ever make the box longer; time-reversed layers count', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  title.outPoint = 8;
  sub.outPoint = 8;
  const box = create(host, comp, [title]);
  box.outPoint = 15;
  comp.select(box, sub);
  host.api.addToBox();
  assert.equal(box.outPoint, 15, 'Add kept it');
  comp.select(box);
  host.api.matteBoxes();
  assert.equal(box.outPoint, 15, 'Matte kept it');
  const host2 = createHost();
  const s2 = scene(host2);
  s2.title.outPoint = 3;
  s2.sub.inPoint = 8;
  s2.sub.outPoint = 1;
  const box2 = create(host2, s2.comp, [s2.title, s2.sub]);
  assert.deepEqual([box2.inPoint, box2.outPoint], [0, 8]);
});

test('locked layers: Apply, Release and Remove skip them and say so; converting unlocks and relocks', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  box.locked = true;
  comp.select(title);
  host.api.applySettings(settings(host, { padding: 50 }));
  assert.match(host.alerts.pop(), /Skipped \(locked\): AutoBox 1/);
  host.confirmAnswer = true;
  comp.select(box);
  host.api.releaseBoxes();
  assert.match(host.alerts.pop(), /Skipped \(locked\)/);
  box.locked = false;
  sub.locked = true;
  comp.select(title, sub);
  host.api.removeFromBox();
  assert.equal(title.parent, null);
  assert.equal(sub.parent, box);
  assert.match(host.alerts.pop(), /Skipped \(locked\): Subtitle/);
  assert.equal(host.undoDepth, 0);
  // An old box with a locked layer converts, and stays locked.
  const host2 = createHost();
  const s2 = scene(host2);
  const old = oldApi('AutoBox-2.0.1.jsx');
  globalThis.AUTOBOX_TEST = {};
  s2.comp.select(s2.title, s2.sub);
  old.createBox(Object.assign({}, old.DEFAULTS));
  const box2 = s2.comp._layers.find((l) => l.name.indexOf('AutoBox') === 0 && !/Stroke/.test(l.name));
  s2.sub.locked = true;
  box2.locked = false;
  s2.comp.select(s2.title);
  host2.confirmAnswer = true;
  host2.api.applySettings(settings(host2));
  assert.ok(!host2.alerts.some((a) => /went wrong/.test(a)), host2.alerts.join('|'));
  assert.equal(s2.sub.locked, true);
  assert.ok(host2.api.homeOf(box2.rectShapes()[0].children[0].expression), 'converted');
});

// ---------------------------------------------------------------------------
// Second review round
// ---------------------------------------------------------------------------
test('a swap gives the same box whenever you make it: before animating, or after with the playhead on either line', () => {
  for (const [createAt, keysFirst] of [[1, false], [1, true], [3, true]]) {
    const host = createHost();
    const comp = host.newComp({ duration: 6 });
    const B = comp.layers.addText('B', { position: [700, 500], rect: { left: 0, top: -40, width: 700, height: 48 }, inPoint: 2 });
    const A = comp.layers.addText('A', { position: [700, 500], rect: { left: 0, top: -40, width: 300, height: 48 } });
    const anim = () => {
      slide(A, [[2, 0, 0, smooth], [2.5, 0, -120]]);
      slide(B, [[2, 0, 120, smooth], [2.5, 0, 0]]);
    };
    if (keysFirst) anim();
    comp.time = createAt;
    const box = create(host, comp, [A, B], { padding: 12, anchor: 1 });
    if (!keysFirst) anim();
    const tag = `made at ${createAt}${keysFirst ? ' after animating' : ''}`;
    near(cut(box, A, 1), 0, `${tag}: A in before the swap`);
    near(rect(box, 1).w, 324, `${tag}: A's size`);
    for (const t of [3, 5]) near(cut(box, B, t), 0, `${tag}: B in after (${t})`);
  }
});

test('adding a layer above, or reordering, doesn\'t change a box (homes go by name)', () => {
  const build = () => {
    const host = createHost();
    const comp = host.newComp({ duration: 8 });
    const rows = [];
    for (let i = 3; i >= 0; i--) rows.unshift(comp.layers.addShapeMember(`Row ${i}`, { position: [700, 300 + i * 70], rect: { left: -200, top: -22, width: 400, height: 44 } }));
    const box = create(host, comp, rows, { padding: 12, anchor: 1 });
    rows.forEach((l, i) => slide(l, [[0.5 + i * 0.5, 0, 60, smooth], [0.9 + i * 0.5, 0, 0]]));
    return { host, comp, rows, box };
  };
  const check = (s, tag) => s.rows.forEach((r, i) => {
    for (const t of [0.91 + i * 0.5, 3, 5]) near(cut(s.box, r, t), 0, `${tag}: row ${i} at ${t}`);
  });
  let s = build();
  check(s, 'as made');
  s.comp.layers.addSolid('Logo', { position: [100, 100], rect: { left: 0, top: 0, width: 50, height: 50 } });
  check(s, 'a layer added on top');
  s = build();
  s.rows[3].moveToBeginning();
  check(s, 'reordered');
  // Box another layer above the list: the list's box doesn't change.
  s = build();
  const head = s.comp.layers.addText('Heading', { position: [700, 150], rect: { left: 0, top: -40, width: 300, height: 44 } });
  create(s.host, s.comp, [head]);
  check(s, 'another box made above');
});

test('homes keep layer names with quotes, backslashes and accents, as plain ES3', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 4 });
  const odd = comp.layers.addText('Odd', { position: [200, 300], rect: { left: 0, top: -40, width: 300, height: 44 } });
  odd.name = 'Say "hi" \\ café, [1] 💬';
  const box = create(host, comp, [odd]);
  const expr = box.rectShapes()[0].children[0].expression;
  acorn.parse(expr, { ecmaVersion: 3, allowReserved: false });
  const home = host.api.homeOf(expr);
  assert.equal(home.length, 1);
  assert.equal(home[0][5], odd.name);
  near(cut(box, odd, 1), 0);
});

test('a layer popping in on the frame another starts sliding: the box still gets ready over Morph Time', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Kicker', 200, 300, 200, 44], ['Title', 200, 380, 520, 44], ['Label', 200, 460, 300, 44, { inPoint: 1 }]]);
  const box = create(host, comp, [L.Kicker, L.Title, L.Label], { padding: 10, anchor: 1, morphTime: 0.4 });
  slide(L.Title, [[1, -900, 0, smooth], [1.6, 0, 0]]);
  near(jumps(box, 0.3, 2), 0, 'no jumps');
  assert.ok(maxStep(box, 0.3, 2) < 90, 'no big steps');
  near(cut(box, L.Label, 1), 0, 'ready when it appears');
});

test('a layer leaving while a slower one that started with another is still coming in refits the box', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Old', 200, 300, 600, 44], ['Name', 200, 540, 360, 44, { inPoint: 2 }], ['Role', 200, 620, 420, 44, { inPoint: 2 }]], 8);
  const box = create(host, comp, [L.Old, L.Name, L.Role], { padding: 10, anchor: 1 });
  slide(L.Name, [[2, -1400, 0, smooth], [2.4, 0, 0]]);
  slide(L.Role, [[2, 0, 300, smooth], [4, 0, 0]]);
  keys(L.Old.tprop('ADBE Opacity'), [[3, 100], [3.3, 0]]);
  near([rect(box, 4.5).w, rect(box, 4.5).h], [440, 144], 'fits Name and Role');
  for (const t of [4, 6]) near(cut(box, L.Role, t), 0);
});

test('text that fades in through its animator\'s own Opacity comes in', () => {
  const host = createHost();
  const { comp, L } = textComp(host, [['Sub', 200, 300, 200, 44], ['Headline', 200, 400, 700, 44]], 6);
  const box = create(host, comp, [L.Sub, L.Headline], { padding: 10, anchor: 1 });
  L.Headline.addAnimator({ opacity: 0 });
  const animOpacity = L.Headline.textState.children[0].children[0].children[1].children[0];
  keys(animOpacity, [[1, 0], [1.5, 100]]);
  near(rect(box, 0.5).w, 220, 'not shown yet');
  for (const t of [2, 4]) near(cut(box, L.Headline, t), 0, `in at ${t}`);
});

test('a landed layer that moves again is kept in; Collapse later on doesn\'t switch that off; no jump to where a layer will be', () => {
  // Lands under a slow line, then nudges while that one is still coming in.
  let host = createHost();
  let { comp, L } = textComp(host, [['Line 0', 200, 300, 600, 44], ['Line 1', 200, 370, 500, 44]], 8);
  let box = create(host, comp, [L['Line 0'], L['Line 1']], { padding: 10, anchor: 1 });
  slide(L['Line 0'], [[0, -900, 0, smooth], [3, 0, 0]]);
  slide(L['Line 1'], [[0.2, -900, 0, smooth], [0.5, 0, 0], [1.0, 0, 0, smooth], [1.4, 20, 0]]);
  for (let f = 16; f <= 60; f += 2) near(cut(box, L['Line 1'], f / 30), 0, `frame ${f}`);
  near(jumps(box, 0.6, 2), 0);
  // With Collapse and a layer coming in after the box collapsed.
  host = createHost();
  ({ comp, L } = textComp(host, [['Line 0', 200, 300, 600, 44], ['Line 1', 200, 370, 300, 44], ['Later', 200, 300, 400, 44, { inPoint: 6 }]], 10));
  box = create(host, comp, [L['Line 0'], L['Line 1'], L.Later], { padding: 10, anchor: 1, whenEmpty: 2 });
  slide(L['Line 0'], [[0, -900, 0, smooth], [1.2, 0, 0], [3, 0, 0, smooth], [3.5, 1500, 0]]);
  slide(L['Line 1'], [[0.2, -900, 0, smooth], [0.4, 0, 0], [3, 0, 0, smooth], [3.5, 1500, 0]]);
  for (const t of [0.4, 0.5, 0.6, 0.8]) near(cut(box, L['Line 1'], t), 0, `Line 1 at ${t}`);
  // A layer that will drift later, with a pop-in getting ready meanwhile.
  host = createHost();
  ({ comp, L } = textComp(host, [['X', 200, 300, 600, 44], ['Z', 200, 380, 200, 44, { inPoint: 2.1 }]], 6));
  box = create(host, comp, [L.X, L.Z], { padding: 10, anchor: 1, morphTime: 0.4 });
  slide(L.X, [[0, 0, 0], [2.05, 0, 0, smooth], [2.6, 300, 0]]);
  near(jumps(box, 1.5, 3), 0);
  near(rect(box, 1.9).r, 620, 'not stretched to where X will be');
});

test('Add to Box and Create Box take a matted box off as the matte of a layer they move out of it', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const a1 = comp.layers.addText('A1', { position: [200, 200], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const a2 = comp.layers.addText('A2', { position: [200, 260], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const b1 = comp.layers.addText('B1', { position: [900, 600], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const boxA = create(host, comp, [a1, a2], { padding: 10, anchor: 1 });
  const boxB = create(host, comp, [b1], { padding: 10, anchor: 1 });
  comp.select(boxA, boxB);
  host.api.matteBoxes();
  host.alerts.length = 0;
  host.confirmAnswer = true;
  comp.select(boxB, a2);
  host.api.addToBox();
  assert.equal(a2.parent, boxB);
  assert.equal(a2.trackMatteLayer, null);
  assert.equal(a1.trackMatteLayer, boxA, 'the others keep it');
  comp.select(a1, b1);
  host.api.createBox(settings(host));
  assert.equal(a1.trackMatteLayer, null);
  assert.equal(b1.trackMatteLayer, null);
});

test('Release of an old box with a locked layer, Matte with a locked layer, Remove with a controller and its layers', () => {
  let host = createHost();
  let { comp, title, sub } = scene(host);
  const old = oldApi('AutoBox-2.0.1.jsx');
  globalThis.AUTOBOX_TEST = {};
  comp.select(title, sub);
  old.createBox(Object.assign({}, old.DEFAULTS, { layout: 2, gap: 10 }));
  const oldBox = comp._layers.find((l) => l.name === 'AutoBox 1');
  sub.locked = true;
  comp.select(oldBox);
  host.confirmAnswer = true;
  assert.equal(host.api.hostRun('release', {}), 'ok');
  assert.equal(sub.locked, true, 'locked again');
  assert.deepEqual(expressions(comp).filter((e) => /Title|Subtitle/.test(e)), [], 'layers baked');
  // Matte names a locked layer it can't matte.
  host = createHost();
  ({ comp, title, sub } = scene(host));
  const box = create(host, comp, [title, sub]);
  sub.locked = true;
  comp.select(box);
  host.api.matteBoxes();
  assert.equal(title.trackMatteLayer, box);
  assert.ok(host.alerts.some((a) => /Skipped \(locked\): Subtitle/.test(a)));
  // A controller null and the layers on it, removed together, stay together.
  host = createHost();
  comp = host.newComp({ duration: 10 });
  const a = comp.layers.addText('A', { position: [200, 280], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const b = comp.layers.addText('B', { position: [200, 340], rect: { left: 0, top: -30, width: 200, height: 30 } });
  const c = comp.layers.addText('C', { position: [200, 420], rect: { left: 0, top: -30, width: 200, height: 30 } });
  const box3 = create(host, comp, [a, b, c], { padding: 10, anchor: 1 });
  const ctrl = comp.layers.addNull({ name: 'Controller', position: [300, 300] });
  ctrl.parent = box3;
  a.parent = ctrl;
  b.parent = ctrl;
  slide(ctrl, [[0, 0, 0], [2, 400, 0]]);
  comp.select(a, ctrl, b);
  host.api.removeFromBox();
  assert.equal(ctrl.parent, null);
  assert.equal(a.parent, ctrl);
  assert.equal(b.parent, ctrl);
  near(a.compBounds(2).l, 600, 'still follows its controller');
});
