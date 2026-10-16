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
  acorn.parse(fs.readFileSync(SCRIPT_PATH, 'utf8'), { ecmaVersion: 3 });
  for (const kind of ['size', 'position']) acorn.parse(host.api.buildExpression(kind), { ecmaVersion: 3 });
  acorn.parse(host.api.buildSwitchProbe(3, 1), { ecmaVersion: 3 });
  acorn.parse(host.api.gradientPointExpression(), { ecmaVersion: 3 });
});

test('the engine only reads controls that every box gets', () => {
  const host = createHost();
  const expr = host.api.buildExpression('size');
  const names = new Set(host.api.CONTROLS.map((c) => c.name));
  const used = [...expr.matchAll(/ab_ctl(?:Prop)?\("([^"]+)"/g)].map((m) => m[1]);
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

test('a layer sliding in: the box grows from Box Anchor on the layer\'s own curve, then holds while it slides out', () => {
  const { box } = titleBox();
  slide(box.comp.layer('Title'), [[1, 0, 200, smooth], [1.5, 0, 0], [3, 0, 0, smooth], [3.5, 0, -200]]);
  const full = rect(box, 2);
  near([full.w, full.h], [440, 100]);
  const cx = (full.l + full.r) / 2, cy = (full.t + full.b) / 2;
  near([rect(box, 0.5).w, rect(box, 0.5).h], [0, 0], 'nothing before it comes in');
  for (const t of [1.1, 1.25, 1.4]) {
    const p = smooth((t - 1) / 0.5), r = rect(box, t);
    near([r.w, r.h], [440 * p, 100 * p], `grows with the layer's easing at ${t}`);
    near([(r.l + r.r) / 2, (r.t + r.b) / 2], [cx, cy], 'from the center (Box Anchor)');
  }
  for (const t of [3.2, 3.5, 6]) near([rect(box, t).w, rect(box, t).h], [440, 100], `holds while it leaves (${t})`);
});

test('Box Anchor sets where the box grows from', () => {
  const { box } = titleBox({ anchor: 4 });
  slide(box.comp.layer('Title'), [[0, 0, 100], [1, 0, 0]]);
  const full = rect(box, 2), half = rect(box, 0.5);
  near([half.l, half.t, half.r, half.b], [full.l, full.t + 25, full.l + 220, full.b - 25], 'Left: from the middle of the left edge');
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
    near(rect(box, 2 + lag).w, 340, `${lag}: still A as B starts`);
    const p = smooth(0.5);
    near(rect(box, 2.25 + lag).w, 340 + (740 - 340) * p, `${lag}: halfway on B's curve`);
    near(rect(box, 3).w, 740, `${lag}: B only, A is gone`);
  }
});

test('a staggered list builds the box line by line, and the box holds when they all leave', () => {
  const build = (gap) => {
    const host = createHost();
    const comp = host.newComp({ duration: 10 });
    const lines = [];
    for (let i = 3; i >= 0; i--) {
      lines.unshift(comp.layers.addText(`Line ${i}`, { position: [200, 300 + i * 50], rect: { left: 0, top: -40, width: 300 + i * 50, height: 40 } }));
    }
    const box = create(host, comp, lines, { padding: 10, anchor: 1 });
    lines.forEach((l, i) => slide(l, [[i * gap, -400, 0, smooth], [i * gap + 0.4, 0, 0], [5, 0, 0], [5.4, 400, 0]]));
    return box;
  };
  // One after the other: the box fits each line as it lands (Top Left anchor:
  // it grows down and right).
  let box = build(0.5);
  for (let i = 0; i < 4; i++) {
    const t = i * 0.5 + 0.4;
    near([rect(box, t).w, rect(box, t).h], [320 + i * 50, 60 + i * 50], `line ${i} in`);
  }
  near([rect(box, 6).w, rect(box, 6).h], [470, 210], 'holds after they all leave');
  // Overlapping: each new line takes over from wherever the box is, smoothly.
  box = build(0.15);
  let prev = rect(box, 0);
  for (let f = 1; f <= 30; f++) {
    const r = rect(box, f / 30);
    assert.ok(Math.abs(r.h - prev.h) < 25 && r.h >= prev.h - 1e-6, `no jumps, never shrinks (frame ${f})`);
    prev = r;
  }
  near([rect(box, 1).w, rect(box, 1).h], [470, 210], 'all four in');
});

test('a layer that appears without keyframes comes in over Morph Time with Morph Ease', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.inPoint = 2;
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).h, 60, 'title only');
  near(rect(box, 2.25).h, 60 + 76 * 0.5, 'linear, halfway');
  near(rect(box, 3).h, 136);
  box.setEffect('Morph Ease', 4);
  near(rect(box, 2.125).h, 60 + 76 * (4 * 0.25 * 0.25 * 0.25), 'ease in out');
  box.setEffect('Morph Time', 0);
  near(rect(box, 2).h, 136, 'Morph Time 0 snaps');
});

test('a layer\'s out point takes it out (the box holds); the next layer in replaces it', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const b = comp.layers.addText('B', { position: [200, 300], rect: { left: 0, top: -50, width: 700, height: 60 }, inPoint: 4 });
  const a = comp.layers.addText('A', { position: [200, 300], rect: { left: 0, top: -50, width: 300, height: 60 }, outPoint: 3 });
  const box = create(host, comp, [a, b], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).w, 300);
  near(rect(box, 3.5).w, 300, 'A is gone, the box holds');
  near(rect(box, 4.25).w, 500, 'morphs to B');
  near(rect(box, 5).w, 700);
});

test('moves between two rests reposition the layer: the box follows on that move\'s curve', () => {
  const { box } = titleBox({ anchor: 1 });
  // in 0..0.5, moves right 200px at 2..3 (eased), out 6..6.5
  slide(box.comp.layer('Title'), [[0, 0, 100], [0.5, 0, 0], [2, 0, 0, smooth], [3, 200, 0], [6, 200, 0], [6.5, 200, -200]]);
  const a = rect(box, 1), b = rect(box, 4);
  near(b.l - a.l, 200, 'ends up around the new spot');
  near(rect(box, 2.5).l - a.l, 200 * smooth(0.5), 'on the move\'s curve');
  near(rect(box, 7).l, b.l, 'holds after the exit');
});

test('overshoot in the layer\'s curve carries over to the box (scale pop)', () => {
  const { box, title } = titleBox();
  title.tprop('ADBE Anchor Point').s.value = [200, -20, 0];
  keys(title.tprop('ADBE Scale'), [[0, [0, 0, 100]], [0.3, [110, 110, 100]], [0.5, [100, 100, 100]]]);
  near(rect(box, 0.3).w, 440 * 1.1, 'overshoots with the layer');
  near(rect(box, 1).w, 440);
});

test('an opacity fade-in or a hold-key jump also counts as coming in', () => {
  const { box, title } = titleBox({ anchor: 1, morphTime: 0.5, morphEase: 1 });
  keys(title.tprop('ADBE Opacity'), [[1, 0, smooth], [2, 100]]);
  near(rect(box, 0.5).w, 0);
  near(rect(box, 1.5).w, 440 * smooth(0.5), 'fades in, box grows on the fade curve');
  keys(title.tprop('ADBE Opacity'), [[1, 0, 'hold'], [2, 100]]);
  near(rect(box, 1.5).w, 0, 'hold: nothing until the jump');
  near(rect(box, 2.25).w, 220, 'then Morph Time');
});

test('keyframed Source Text: the box morphs to the new text', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const title = comp.layers.addText('Title', {
    position: [200, 300], textKeys: [0, 2],
    rect: (t) => (t < 2 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 }),
  });
  const box = create(host, comp, [title], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  near(rect(box, 1).w, 400);
  near(rect(box, 2.25).w, 500);
  near(rect(box, 3).w, 600);
  // Slid 1s along the timeline: still measured at the right time.
  title.startTime = 1;
  title.rect = (t) => (t < 3 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 });
  title.textKeys = [1, 3];
  near(rect(box, 2).w, 400);
  near(rect(box, 4).w, 600);
});

test('a text animator reveal drives the box', () => {
  const { box, title } = titleBox({ anchor: 1 });
  const sel = title.addAnimator();
  keys(sel.end, [[1, 0, smooth], [2, 100]]);
  near(rect(box, 0.5).w, 0);
  near(rect(box, 1.5).w, 440 * smooth(0.5));
  near(rect(box, 3).w, 440);
});

test('separated position dimensions and riders (layers parented to a member)', () => {
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
  // A rider moves with its parent's keyframes.
  const icon = comp.layers.addShapeMember('Icon', { position: [0, 0], rect: { left: 0, top: 0, width: 20, height: 20 } });
  icon.parent = sub;
  icon.tprop('ADBE Position').s.value = [-60, -30, 0];
  near(rect(box, 3).l, -40, 'icon sticks out left of the subtitle');
  near(rect(box, 0.5).l, 0, 'not before its parent comes in');
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

test('In Box checkbox: off never counts, keyed on brings the layer in, keyed off lets the box hold', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 1, morphTime: 0.5, morphEase: 1 });
  const add = (layer) => {
    new Prop(layer.effectsState).addProperty('ADBE Checkbox Control').name = 'In Box';
    return layer.effectsState.children.find((e) => e.name === 'In Box').children[0];
  };
  const cb = add(sub);
  near(rect(box, 1).h, 60, 'unchecked: the subtitle never changes the box');
  // The subtitle slides in at 2..3 but only counts once In Box turns on at 2.5:
  // the box borrows the rest of the slide's curve.
  slide(sub, [[2, 0, 200], [3, 0, 0]]);
  keys(cb, [[0, 0], [2.5, 1], [6, 0]]);
  near(rect(box, 2.4).h, 60);
  near(rect(box, 2.75).h, 60 + 76 * 0.5, 'renormalized: halfway through what is left');
  near(rect(box, 4).h, 136);
  near(rect(box, 7).h, 136, 'switched off: the box holds');
  // No move when it switches on: Morph Time.
  keys(cb, [[0, 0], [4, 1]]);
  near(rect(box, 4.25).h, 98);
  // Checked without keys: always in, counted where it is; its moves only
  // reposition it.
  keys(cb, []);
  cb.value = 1;
  near(rect(box, 1).h, 336, 'in from the start, 200px down (not waiting for its first move)');
  near(rect(box, 2.5).h, 236, 'repositions on the slide');
  near(rect(box, 4).h, 136);
});

test('the In Box button keys the checkbox to what AutoBox does on its own', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { padding: 0, anchor: 5 });
  slide(title, [[1, 0, 200, smooth], [1.5, 0, 0], [3, 0, 0], [3.5, 0, -200]]);
  const times = [];
  for (let f = 0; f <= 150; f += 5) times.push(f / 30);
  const before = times.map((t) => rect(box, t));
  comp.select(title, sub);
  host.api.addInBoxToggles();
  assert.deepEqual(host.alerts, []);
  const tcb = title.effectsState.children.find((e) => e.name === 'In Box').children[0];
  const scb = sub.effectsState.children.find((e) => e.name === 'In Box').children[0];
  assert.deepEqual(tcb.keys.map((k) => [k.t, k.v]), [[0, 0], [1, 1], [3, 0]]);
  assert.deepEqual(scb.keys, []);
  near(scb.value, 1);
  times.forEach((t, i) => {
    const r = rect(box, t);
    near([r.l, r.t, r.r, r.b], [before[i].l, before[i].t, before[i].r, before[i].b], `same box at ${t}`);
  });
  // Again: already there.
  comp.select(title);
  host.api.addInBoxToggles();
  assert.match(host.alerts.pop(), /already has an In Box checkbox/);
});

test('Freeze holds the box, then eases back to where it should be', () => {
  const { box, title } = titleBox({ anchor: 1, morphTime: 0.5, morphEase: 1 });
  title.setText({ left: 0, top: -50, width: 400, height: 60 });
  const freeze = box.effectsState.children.find((e) => e.name === 'Freeze').children[0];
  // The title grows (Source Text) at 2; frozen 1..3.
  title.textKeys = [0, 2];
  title.rect = (t) => (t < 2 ? { left: 0, top: -50, width: 400, height: 60 } : { left: 0, top: -50, width: 600, height: 60 });
  keys(freeze, [[0, 0], [1, 1], [3, 0]]);
  near(rect(box, 2.6).w, 440, 'frozen at its 1s shape');
  near(rect(box, 3.25).w, 440 + 200 * 0.5, 'eases back over Morph Time');
  near(rect(box, 4).w, 640);
  // Frozen from the start: holds the shape it has when Freeze turns off.
  keys(freeze, [[0, 1], [2.5, 0]]);
  near(rect(box, 0.5).w, rect(box, 2.5).w);
  near(rect(box, 2.5).w, 640 - 200 * 0, 'continuous when it unfreezes');
});

test('nested boxes: the outer box follows the inner box\'s own morphs, with no expression cycles', () => {
  const host = createHost();
  const comp = host.newComp({ duration: 10 });
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 100, height: 36 } });
  const icon = comp.layers.addShapeMember('Icon', { position: [200, 280], rect: { left: 0, top: -40, width: 40, height: 40 } });
  const title = comp.layers.addText('Title', { position: [260, 280], rect: { left: 0, top: -40, width: 300, height: 40 } });
  const inner = create(host, comp, [icon, title], { padding: 10, anchor: 1, strokeWidth: 4 });
  const outer = create(host, comp, [inner, sub], { padding: 20, anchor: 1 });
  assert.equal(inner.parent, outer);
  assert.equal(icon.parent, inner);
  const ib = inner.boxCompBounds(1);
  near(outer.boxCompBounds(1).t, ib.t - 2 - 20, 'counts the inner box\'s stroke');
  // The title slides into the inner box: the outer box grows along with it.
  slide(title, [[1, 0, 100, smooth], [2, 0, 0]]);
  const w = (t) => outer.boxRect(t).w;
  assert.ok(w(1.25) < w(1.5) && w(1.5) < w(2), 'grows with the inner box');
  near(w(2), w(3));
  for (const l of [inner, outer]) {
    for (const mn of ['ADBE Vector Rect Size', 'ADBE Vector Rect Position']) assert.equal(item(l, 'Box Rect')(mn).s.expressionError, '');
  }
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
