'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const acorn = require('acorn');
const path = require('path');
const vm = require('vm');
const { createHost, Prop, SCRIPT_PATH } = require('./ae-mock');

const EPS = 1e-6;

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
  const comp = host.newComp(opts.comp);
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

// Layout expressions (box sizing and member positions), as "Layer > Property".
function rigExpressions(comp) {
  const out = [];
  const walk = (l, s) => {
    if (/^\/\/ AutoBox (box|member)/.test(s.expression)) out.push(`${l.name} > ${s.name}`);
    s.children.forEach((c) => walk(l, c));
  };
  comp._layers.forEach((l) => walk(l, l.root));
  return out;
}

function item(layer, groupName, name) {
  const g = layer.contentsState.children.find((c) => c.name === groupName);
  const c = g.children.find((x) => x.matchName === 'ADBE Vectors Group').children.find((x) => x.name === name);
  if (!c) throw new Error(`no ${name} in ${layer.name}`);
  return (mn) => new Prop(c.children.find((x) => x.matchName === mn));
}

function effectProp(layer, effectName, mn) {
  const e = layer.effectsState.children.find((c) => c.name === effectName);
  return new Prop(e.children.find((c) => c.matchName === mn));
}

test('script and generated expressions are plain ES3 (Legacy ExtendScript engine)', () => {
  const host = createHost();
  acorn.parse(fs.readFileSync(SCRIPT_PATH, 'utf8'), { ecmaVersion: 3 });
  for (const kind of ['size', 'position', 'roundness', 'member', 'memberX', 'memberY']) {
    acorn.parse(host.api.buildExpression(kind), { ecmaVersion: 3 });
  }
});

test('the engine only reads controls that every box gets', () => {
  const host = createHost();
  const expr = host.api.buildExpression('size');
  const names = new Set(host.api.CONTROLS.map((c) => c.name));
  const used = [...expr.matchAll(/ab_ctl\("([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 10);
  used.forEach((n) => assert.ok(names.has(n), `missing control ${n}`));
});

test('Create Box wraps the selection with padding and leaves the layers where they are', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);

  assert.equal(box.name, 'AutoBox 1');
  assert.deepEqual(comp._layers.map((l) => l.name), ['Title', 'Subtitle', 'AutoBox 1 Stroke', 'AutoBox 1'],
    'box (and its stroke layer) sit behind its layers');
  assert.equal(title.parent, box);
  assert.equal(sub.parent, box);
  bounds(title.compBounds(), 200, 250, 600, 310, 'title unchanged');
  bounds(sub.compBounds(), 220, 350, 520, 386, 'subtitle unchanged');
  bounds(box.boxCompBounds(), 168, 218, 632, 418, 'box = union + 32px padding');
  near(box.tprop('ADBE Position').value.slice(0, 2), [168, 218], 'box layer sits on its top-left anchor');
  near(box.boxRect().roundness, 16, 'corner radius');
  near(box.effectValue('Ignore Hidden'), 1);
  near(box.effectValue('Layout'), 1);
  assert.deepEqual(box.effectsState.children.map((e) => e.name), host.api.CONTROLS.map((c) => c.name).concat(['Fill Tint']));
  assert.deepEqual(box.effectsState.children[0].children[0].items, ['Free (wrap)', 'Vertical Stack', 'Horizontal Stack']);
  assert.ok(host.undoGroups.includes('AutoBox: Create Box'));
});

test('padding, extra padding and corner radius are live', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  box.setEffect('Padding', 10);
  box.setEffect('Extra Left', 30);
  box.setEffect('Extra Bottom', 5);
  bounds(box.boxCompBounds(), 160, 240, 610, 401);
  box.setEffect('Corner Radius', 500);
  near(box.boxRect().roundness, 161 / 2, 'radius is clamped to half the short side');
});

test('solid fill and stroke follow the Effect Controls', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillColor: [1, 0.5, 0], strokeWidth: 0 });
  const fill = item(box, 'AutoBox', 'Fill');
  near(fill('ADBE Vector Fill Color').value, [1, 0.5, 0, 1]);
  near(fill('ADBE Vector Fill Opacity').value, 100);
  near(item(box, 'AutoBox', 'Linear Gradient Fill')('ADBE Vector Fill Opacity').value, 0);
  near(item(box, 'AutoBox', 'Radial Gradient Fill')('ADBE Vector Fill Opacity').value, 0);
  near(effectProp(box, 'Fill Tint', 'ADBE Tint-0003').value, 0, 'no tint on a solid fill');

  const sl = comp.layer('AutoBox 1 Stroke');
  assert.equal(sl.parent, box);
  assert.equal(sl.index, box.index - 1, 'stroke layer sits right above the box');
  // Solid on solid: drawn inside the box (above the fills) so both fade as one layer.
  const group = box.contentsState.children[0].children[0].children.map((c) => c.name);
  assert.deepEqual(group, ['Box Rect', 'Stroke', 'Fill', 'Linear Gradient Fill', 'Radial Gradient Fill']);
  const stroke = item(box, 'AutoBox', 'Stroke');
  const layerStroke = item(sl, 'AutoBox Stroke', 'Stroke');
  near(stroke('ADBE Vector Stroke Opacity').value, 0, 'no stroke at width 0');
  box.setEffect('Stroke Width', 4);
  box.setEffect('Stroke Color', [0, 1, 0, 1]);
  near(stroke('ADBE Vector Stroke Opacity').value, 100);
  near(layerStroke('ADBE Vector Stroke Opacity').value, 0, 'the stroke layer stays empty');
  near(stroke('ADBE Vector Stroke Width').value, 4);
  near(stroke('ADBE Vector Stroke Color').value, [0, 1, 0, 1]);
  box.setEffect('Stroke Opacity', 40);
  near(stroke('ADBE Vector Stroke Opacity').value, 40);
  box.setEffect('Fill Type', 2);
  near(stroke('ADBE Vector Stroke Opacity').value, 0, 'a gradient fill would tint it, so...');
  near(layerStroke('ADBE Vector Stroke Opacity').value, 40, '...it moves to the stroke layer');
  near(layerStroke('ADBE Vector Stroke Color').value, [0, 1, 0, 1]);
  box.setEffect('Fill Type', 1);

  bounds(sl.boxCompBounds(), 168, 218, 632, 342, 'stroke layer traces the box');
  box.tprop('ADBE Opacity').setValue(30);
  near(sl.tprop('ADBE Opacity').value, 30, 'stroke layer follows the box opacity');
  box.enabled = false;
  near(sl.tprop('ADBE Opacity').value, 0, '...and its visibility');
  box.enabled = true;
  box.setEffect('Stroke Width', 60);
  bounds(box.boxCompBounds(), 168, 218, 632, 342, 'the box never wraps its own stroke');
});

test('gradient fills span the box at any angle and are recolored by Tint', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { fillType: 2, fillAngle: 90, fillColor: [1, 0, 0], fillColor2: [0, 0, 1] });
  // Box rect in box space: 0..464 x 0..200, center (232, 100).
  const lin = item(box, 'AutoBox', 'Linear Gradient Fill');
  near(item(box, 'AutoBox', 'Fill')('ADBE Vector Fill Opacity').value, 0);
  near(lin('ADBE Vector Fill Opacity').value, 100);
  near(lin('ADBE Vector Grad Start Pt').value, [0, 100], '90 degrees runs left to right');
  near(lin('ADBE Vector Grad End Pt').value, [464, 100]);
  near(effectProp(box, 'Fill Tint', 'ADBE Tint-0003').value, 100);
  near(effectProp(box, 'Fill Tint', 'ADBE Tint-0002').value, [1, 0, 0, 1], 'white (start) -> Fill Color');
  near(effectProp(box, 'Fill Tint', 'ADBE Tint-0001').value, [0, 0, 1, 1], 'black (end) -> Fill Color 2');
  assert.throws(() => lin('ADBE Vector Grad Colors').value, /no value/, 'gradient colors are never touched');

  box.setEffect('Fill Angle', 180);
  near(lin('ADBE Vector Grad Start Pt').value, [232, 0], '180 degrees runs top to bottom');
  near(lin('ADBE Vector Grad End Pt').value, [232, 200]);
  box.setEffect('Fill Angle', 45);
  const half = (464 * Math.SQRT1_2 + 200 * Math.SQRT1_2) / 2;
  near(lin('ADBE Vector Grad Start Pt').value, [232 - half * Math.SQRT1_2, 100 + half * Math.SQRT1_2]);
  near(lin('ADBE Vector Grad End Pt').value, [232 + half * Math.SQRT1_2, 100 - half * Math.SQRT1_2]);

  title.setText({ left: 0, top: -50, width: 600, height: 60 });
  box.setEffect('Fill Angle', 90);
  near(lin('ADBE Vector Grad End Pt').value, [664, 100], 'follows the box as it grows');

  box.setEffect('Fill Type', 3);
  const rad = item(box, 'AutoBox', 'Radial Gradient Fill');
  near(lin('ADBE Vector Fill Opacity').value, 0);
  near(rad('ADBE Vector Fill Opacity').value, 100);
  assert.equal(rad('ADBE Vector Grad Type').value, 2);
  near(rad('ADBE Vector Grad Start Pt').value, [332, 100], 'radial starts at the center');
  near(rad('ADBE Vector Grad End Pt').value, [332 + Math.hypot(664, 200) / 2, 100], '...and reaches the corners');
});

test('gradient strokes live on the stroke layer and reach its outer edge', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { strokeType: 2, strokeWidth: 10, strokeAngle: 90, strokeColor: [1, 1, 0], strokeColor2: [0, 1, 1] });
  const sl = comp.layer('AutoBox 1 Stroke');
  const lin = item(sl, 'AutoBox Stroke', 'Linear Gradient Stroke');
  near(item(sl, 'AutoBox Stroke', 'Stroke')('ADBE Vector Stroke Opacity').value, 0);
  near(lin('ADBE Vector Stroke Opacity').value, 100);
  near(lin('ADBE Vector Stroke Width').value, 10);
  // Box rect 0..464 x 0..124; the stroke reaches 5px past it.
  near(lin('ADBE Vector Grad Start Pt').value, [-5, 62]);
  near(lin('ADBE Vector Grad End Pt').value, [469, 62]);
  near(effectProp(sl, 'Stroke Tint', 'ADBE Tint-0003').value, 100);
  near(effectProp(sl, 'Stroke Tint', 'ADBE Tint-0002').value, [1, 1, 0, 1]);
  near(effectProp(sl, 'Stroke Tint', 'ADBE Tint-0001').value, [0, 1, 1, 1]);
  near(effectProp(box, 'Fill Tint', 'ADBE Tint-0003').value, 0, 'the fill keeps its solid color');
  box.setEffect('Stroke Type', 3);
  near(lin('ADBE Vector Stroke Opacity').value, 0);
  near(item(sl, 'AutoBox Stroke', 'Radial Gradient Stroke')('ADBE Vector Stroke Opacity').value, 100);
  box.setEffect('Stroke Width', 0);
  near(item(sl, 'AutoBox Stroke', 'Radial Gradient Stroke')('ADBE Vector Stroke Opacity').value, 0, 'width 0 hides it');
});

test('a nested box counts its stroke in an outer stack', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const inner = create(host, comp, [title], { padding: 10, strokeWidth: 20 });
  const outer = create(host, comp, [inner, sub], { layout: 2, padding: 20, gap: 8 });
  const ib = inner.boxCompBounds(), sb = sub.compBounds(), ob = outer.boxCompBounds();
  near(ob.l, ib.l - 10 - 20, 'outer padding starts at the outside of the stroke');
  near(sb.t, ib.b + 10 + 8, 'gap starts below the stroke');
  assert.equal(comp.layer('AutoBox 1 Stroke').parent, inner);
});

test('vertical stack: gap, alignment and anchor', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });

  bounds(title.compBounds(), 200, 250, 600, 310, 'title first');
  bounds(sub.compBounds(), 200, 326, 500, 362, 'subtitle 16px below');
  bounds(box.boxCompBounds(), 168, 218, 632, 394);

  box.setEffect('Align', 2);
  bounds(sub.compBounds(), 250, 326, 550, 362, 'centered');
  box.setEffect('Align', 3);
  bounds(sub.compBounds(), 300, 326, 600, 362, 'right-aligned');

  box.setEffect('Gap', 40);
  bounds(sub.compBounds(), 300, 350, 600, 386);

  box.setEffect('Box Anchor', 5); // Center: the box layer position is the box center
  bounds(box.boxCompBounds(), 168 - 232, 218 - 100, 168 + 232, 218 + 100);
  bounds(title.compBounds(), 168 - 200, 218 - 68, 168 + 200, 218 - 8);
});

test('stack order follows the timeline and updates when layers are reordered', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  sub.moveToBeginning();
  bounds(sub.compBounds(), 200, 250, 500, 286, 'subtitle now first');
  bounds(title.compBounds(), 200, 302, 600, 362);
  bounds(box.boxCompBounds(), 168, 218, 632, 394);
});

test('horizontal stack, justify and min size', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 3 });
  bounds(title.compBounds(), 200, 250, 600, 310);
  bounds(sub.compBounds(), 616, 250, 916, 286);
  bounds(box.boxCompBounds(), 168, 218, 948, 342);

  box.setEffect('Align', 2);
  bounds(sub.compBounds(), 616, 262, 916, 298);

  box.setEffect('Min Width', 1000);
  bounds(box.boxCompBounds(), 168, 218, 1168, 342);
  bounds(title.compBounds(), 200, 250, 600, 310, 'justify start');
  box.setEffect('Justify', 2);
  bounds(title.compBounds(), 310, 250, 710, 310, 'justify center');
  box.setEffect('Justify', 3);
  bounds(title.compBounds(), 420, 250, 820, 310, 'justify end');
  box.setEffect('Justify', 4);
  bounds(title.compBounds(), 200, 250, 600, 310, 'space between');
  bounds(sub.compBounds(), 836, 262, 1136, 298);
});

test('free layout min size grows away from the anchor', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  box.setEffect('Min Width', 600);
  box.setEffect('Min Height', 300);
  bounds(box.boxCompBounds(), 168, 218, 768, 518);
  box.setEffect('Box Anchor', 9);
  bounds(box.boxCompBounds(), 32, 118, 632, 418);
});

test('the box and the stack follow text that changes over time', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  title.setText((t) => ({ left: 0, top: -50, width: 400 + 100 * t, height: 60 + 40 * t }));
  const box = create(host, comp, [title, sub]);
  bounds(box.boxCompBounds(0), 168, 218, 632, 418);
  bounds(box.boxCompBounds(1), 168, 218, 732, 418, 'free: grows with the text');

  box.setEffect('Layout', 2);
  box.setEffect('Align', 2);
  bounds(sub.compBounds(1), 300, 366, 600, 402, 'stack reflows at t=1');
  bounds(box.boxCompBounds(1), 168, 218, 732, 434);
});

test('hidden layers leave the layout unless Ignore Hidden is off', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  sub.enabled = false;
  bounds(box.boxCompBounds(), 168, 218, 632, 342);
  box.setEffect('Ignore Hidden', 0);
  bounds(box.boxCompBounds(), 168, 218, 632, 394);
  box.setEffect('Ignore Hidden', 1);
  sub.enabled = true;
  sub.inPoint = 2;
  bounds(box.boxCompBounds(0), 168, 218, 632, 342, 'before its in point');
  bounds(box.boxCompBounds(3), 168, 218, 632, 394, 'after its in point');
});

test('creating a box mid-animation still measures layers that are not on screen yet', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.inPoint = 5;
  const box = create(host, comp, [title, sub]);
  bounds(box.boxCompBounds(6), 168, 218, 632, 418);
  near(box.inPoint, 0);
});

test('scaled members and a rotated box', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  title.tprop('ADBE Scale').setValue([50, 50, 100]);
  const box = create(host, comp, [title, sub], { layout: 2 });
  bounds(title.compBounds(), 200, 275, 400, 305, 'title at half size');
  bounds(sub.compBounds(), 200, 321, 500, 357);
  bounds(box.boxCompBounds(), 168, 243, 532, 389);

  box.setEffect('Layout', 1);
  const before = box.boxRect();
  box.tprop('ADBE Rotate Z').setValue(30);
  const after = box.boxRect();
  near([after.l, after.t, after.r, after.b], [before.l, before.t, before.r, before.b], 'rect is stable in box space');
});

test('layers with separated position dimensions', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.tprop('ADBE Position').dimensionsSeparated = true;
  const box = create(host, comp, [title, sub], { layout: 2 });
  assert.match(sub.tprop('ADBE Position_0').expression, /^\/\/ AutoBox member/);
  assert.match(sub.tprop('ADBE Position_1').expression, /^\/\/ AutoBox member/);
  bounds(sub.compBounds(), 200, 326, 500, 362);
  bounds(box.boxCompBounds(), 168, 218, 632, 394);
});

test('a member parented to another member rides along instead of taking a slot', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const dot = comp.layers.addShapeMember('Dot', { position: [180, 280], rect: { left: -5, top: -5, width: 10, height: 10 } });
  dot.parent = title;
  const box = create(host, comp, [dot, title, sub], { layout: 2 });
  assert.equal(dot.parent, title);
  // The dot widened the selection, so the stack starts 25px further left.
  bounds(title.compBounds(), 175, 250, 575, 310);
  bounds(sub.compBounds(), 175, 326, 475, 362, 'dot takes no slot');
  bounds(dot.compBounds(), 150, 275, 160, 285, 'dot stays with the title');
  box.setEffect('Align', 3);
  bounds(dot.compBounds(), 150, 275, 160, 285);
  bounds(sub.compBounds(), 275, 326, 575, 362);
});

test('Add to Box and Remove', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title], { layout: 2 });
  bounds(box.boxCompBounds(), 168, 218, 632, 342);

  comp.select(box, sub);
  host.api.addToBox();
  assert.deepEqual(host.alerts, []);
  assert.equal(sub.parent, box);
  bounds(sub.compBounds(), 200, 326, 500, 362);
  bounds(box.boxCompBounds(), 168, 218, 632, 394);

  comp.select(sub);
  host.api.removeFromBox();
  assert.deepEqual(host.alerts, []);
  assert.equal(sub.parent, null);
  assert.equal(sub.tprop('ADBE Position').expression, '');
  bounds(sub.compBounds(), 200, 326, 500, 362, 'removed layer keeps its place');
  bounds(box.boxCompBounds(), 168, 218, 632, 342, 'box shrinks back');
  assert.equal(host.undoDepth, 0);

  comp.select(box);
  host.api.selectMembers();
  assert.deepEqual(comp.selectedLayers.map((l) => l.name), ['Title']);
});

test('Apply to Box pushes panel settings to the selected box', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  comp.select(title); // a member is enough to find its box
  host.api.applySettings(settings(host, { padding: 8, layout: 2, radius: 4 }));
  near(box.effectValue('Padding'), 8);
  near(box.effectValue('Layout'), 2);
  bounds(box.boxCompBounds(), 168, 218, 584, 346, 'stack grows from the top-left anchor');
  near(box.boxRect().roundness, 4);
});

test('Release bakes the animated layout into keyframes', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host, { comp: { duration: 2, frameRate: 10 } });
  title.setText((t) => ({ left: 0, top: -50, width: 400 + (t >= 1 ? 100 : 0), height: 60 }));
  const box = create(host, comp, [title, sub], { layout: 2, align: 2 });
  const sample = (t) => ({ sub: sub.compBounds(t), box: box.boxCompBounds(t) });
  const expected = [0, 0.5, 1, 1.5].map(sample);

  comp.select(box);
  host.api.releaseBoxes();
  assert.deepEqual(host.alerts, []);
  assert.equal(host.confirms.length, 1);
  assert.deepEqual(rigExpressions(comp), [], 'no AutoBox expressions left');
  [0, 0.5, 1, 1.5].forEach((t, i) => {
    const got = sample(t);
    bounds(got.sub, expected[i].sub.l, expected[i].sub.t, expected[i].sub.r, expected[i].sub.b, `subtitle @${t}`);
    bounds(got.box, expected[i].box.l, expected[i].box.t, expected[i].box.r, expected[i].box.b, `box @${t}`);
  });
  assert.equal(title.tprop('ADBE Position').numKeys, 0, 'title never moved: static value');
  assert.ok(sub.tprop('ADBE Position').numKeys >= 2, 'subtitle moved: keyframed');
  assert.ok(sub.tprop('ADBE Position').numKeys <= 4, 'only frames where it changes are keyed');
  assert.deepEqual(box.effectsState.children.map((e) => e.name), host.api.CONTROLS.filter((c) => c.keep).map((c) => c.name).concat(['Fill Tint']),
    'only the fill and stroke controls stay');
  comp.select(box);
  host.api.selectMembers();
  assert.match(host.alerts.pop(), /Select a box layer/, 'a released box is no longer a box');
});

test('Release keeps keyframes on free-layout members', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub]);
  const pos = sub.tprop('ADBE Position');
  pos.setValueAtTime(0, [52, 162, 0]);
  pos.setValueAtTime(1, [100, 162, 0]);
  comp.select(box);
  host.api.releaseBoxes();
  assert.equal(pos.numKeys, 2);
  assert.equal(pos.expression, '');
});

test('boxes nest without expression cycles', () => {
  const host = createHost();
  const comp = host.newComp();
  const sub = comp.layers.addText('Subtitle', { position: [100, 200], rect: { left: 0, top: -30, width: 500, height: 36 } });
  const title = comp.layers.addText('Title', { position: [140, 110], rect: { left: 0, top: -50, width: 300, height: 60 } });
  const icon = comp.layers.addShapeMember('Icon', { position: [100, 90], rect: { left: -20, top: -20, width: 40, height: 40 } });

  const inner = create(host, comp, [icon, title], { layout: 3, align: 2, padding: 10, gap: 12 });
  const outer = create(host, comp, [inner, sub], { layout: 2, padding: 20, gap: 8 });
  assert.equal(outer.name, 'AutoBox 2');
  assert.equal(inner.parent, outer);
  assert.equal(title.parent, inner);

  const ib = inner.boxCompBounds(), ob = outer.boxCompBounds(), sb = sub.compBounds();
  near(ib.r - ib.l, 10 + 40 + 12 + 300 + 10, 'inner width');
  near(ib.b - ib.t, 10 + 60 + 10, 'inner height');
  near(ob.l, ib.l - 20);
  near(ob.t, ib.t - 20);
  near(sb.t, ib.b + 8, 'subtitle stacks under the inner box');
  near(ob.r - ob.l, 20 + 500 + 20, 'outer fits the wider subtitle');
  near(ob.b, sb.b + 20);

  title.setText({ left: 0, top: -50, width: 700, height: 60 });
  const ob2 = outer.boxCompBounds(), ib2 = inner.boxCompBounds();
  near(ib2.r - ib2.l, 10 + 40 + 12 + 700 + 10, 'inner grows');
  near(ob2.r - ob2.l, ib2.r - ib2.l + 40, 'outer grows with it');

  inner.setEffect('Layout', 1);
  outer.setEffect('Layout', 1);
  outer.boxCompBounds();
});

test('editing text, renaming and reordering never break a box', () => {
  const host = createHost();
  const comp = host.newComp();
  // Never-renamed text layers: their names follow their text, like in After Effects.
  const sub = comp.layers.addText('Subtitle', { isNameSet: false, text: 'Hello', position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { isNameSet: false, text: 'Hello', position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  const box = create(host, comp, [title, sub], { layout: 2 });
  assert.equal(title.isNameSet, false, 'AutoBox no longer renames layers');
  bounds(box.boxCompBounds(), 168, 218, 632, 394);

  title.sourceText = 'A much longer headline';
  title.setText({ left: 0, top: -50, width: 700, height: 60 });
  assert.equal(title.name, 'A much longer headline');
  bounds(box.boxCompBounds(), 168, 218, 932, 394, 'box follows the new text');
  bounds(sub.compBounds(), 200, 326, 500, 362);

  sub.sourceText = 'Line one\rLine two';
  sub.setText({ left: 0, top: -30, width: 320, height: 80 });
  bounds(box.boxCompBounds(), 168, 218, 932, 438);

  title.name = 'Headline';
  box.name = 'Lower Third';
  bounds(box.boxCompBounds(), 168, 218, 932, 438, 'renames are fine');
  sub.moveToBeginning();
  bounds(sub.compBounds(), 200, 250, 520, 330, 'reorder restacks');
});

test('duplicating a box together with its layers gives an independent copy', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  // Duplicate all three; After Effects keeps the copies parented to the copied box.
  const box2 = box.duplicate(), title2 = title.duplicate(), sub2 = sub.duplicate();
  title2.setParentWithJump(box2);
  sub2.setParentWithJump(box2);
  box2.tprop('ADBE Position').setValue([168, 618, 0]);
  title2.setText({ left: 0, top: -50, width: 900, height: 60 });
  bounds(box.boxCompBounds(), 168, 218, 632, 394, 'original untouched');
  bounds(box2.boxCompBounds(), 168, 618, 1132, 794, 'copy follows its own layers');
  bounds(sub2.compBounds(), 200, 726, 500, 762);
});

test('parenting a layer to a box adds it', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title]);
  sub.parent = box; // pick whip
  bounds(box.boxCompBounds(), 168, 218, 632, 418, 'free layout wraps it straight away');
  box.setEffect('Layout', 2);
  comp.select(box);
  host.api.applySettings(settings(host, { layout: 2 }));
  assert.match(sub.tprop('ADBE Position').expression, /^\/\/ AutoBox member/, 'Apply to Box rigs new children');
  bounds(sub.compBounds(), 200, 326, 500, 362);
});

test('a deleted member does not break the box', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  sub.remove();
  bounds(box.boxCompBounds(), 168, 218, 632, 342);
  bounds(title.compBounds(), 200, 250, 600, 310);
});

test('cameras, nulls and layers already in a box are skipped', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const cam = comp.layers.addCamera('Camera 1');
  const nul = comp.layers.addNull();
  comp.select(cam, nul, title);
  host.api.createBox(settings(host));
  assert.equal(host.alerts.length, 1);
  assert.match(host.alerts[0], /Camera 1/);
  assert.match(host.alerts[0], /Null 1/);
  host.alerts.length = 0;

  // Selecting layers that are already in a box moves them to the new one.
  comp.select(title, sub);
  host.api.createBox(settings(host));
  assert.deepEqual(host.alerts, []);
  const box2 = comp.layer('AutoBox 2');
  assert.equal(title.parent, box2);
  assert.equal(sub.parent, box2);
  bounds(box2.boxCompBounds(), 168, 218, 632, 418);
  bounds(comp.layer('AutoBox 1').boxRect(), 0, 0, 0, 0, 'the old box is empty');
});

test('nothing selected gives a friendly message', () => {
  const host = createHost();
  const { comp } = scene(host);
  comp.select();
  host.api.createBox(settings(host));
  assert.match(host.alerts[0], /Select the layers/);
  host.app.project.activeItem = null;
  host.api.createBox(settings(host));
  assert.match(host.alerts[1], /Open a composition/);
});

test('the panel builds, remembers settings and its buttons work', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const panel = new Panel();
  host.api.buildUI(panel);
  const find = (pred) => panel.find(pred);
  const radius = find((c) => c.type === 'edittext' && /Corner radius/.test(c.helpTip));
  radius.text = '24';
  radius.onChange.call(radius);
  const mode = find((c) => c.type === 'dropdownlist' && c.items.length === 3 && c.items[0].text === 'Free (wrap)');
  mode.selection = 1;
  mode.onChange.call(mode);

  comp.select(title, sub);
  const button = (label) => find((c) => c.type === 'button' && c.text === label);
  button('Create Box').onClick();
  assert.deepEqual(host.alerts, []);
  const box = comp.layer('AutoBox 1');
  near(box.boxRect().roundness, 24);
  near(box.effectValue('Layout'), 2);

  button('Select Members').onClick();
  assert.deepEqual(comp.selectedLayers.map((l) => l.name), ['Title', 'Subtitle']);
  button('?').onClick();
  assert.match(host.alerts.pop(), /CREATE BOX/);

  const panel2 = new Panel();
  host.api.buildUI(panel2);
  assert.equal(panel2.find((c) => c.type === 'edittext' && /Corner radius/.test(c.helpTip)).text, '24');

  const swatch = panel2.find((c) => c.type === 'button' && /^Fill color/.test(c.helpTip));
  swatch.onDraw();
  swatch.onClick();
  comp.select(box);
  panel2.find((c) => c.type === 'button' && c.text === 'Apply to Box').onClick();
  near(box.effectValue('Fill Color'), [0x33 / 255, 0x66 / 255, 0x99 / 255, 1]);
  assert.deepEqual(host.alerts, []);
});

test('deleting the box leaves its layers usable', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  box.remove();
  assert.equal(sub.parent, null);
  sub.compBounds(); // member expressions fall back to the layer's own position
  comp.select(sub);
  host.api.removeFromBox();
  assert.deepEqual(host.alerts, []);
  assert.equal(sub.tprop('ADBE Position').expression, '');
});

test('a camera or light parented to a box cannot break it', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title, sub], { layout: 2 });
  const cam = comp.layers.addCamera('Camera 1');
  cam.parent = box;
  bounds(box.boxCompBounds(), 168, 218, 632, 394, 'stack ignores the camera');
  box.setEffect('Layout', 1);
  bounds(box.boxCompBounds(), 168, 218, 632, 418, 'free layout ignores it too');
});

test('Apply to Box upgrades a box made by AutoBox 1.0 and keeps its settings', () => {
  const host = createHost();
  // Build the box with the real 1.0 script.
  globalThis.AUTOBOX_TEST = {};
  vm.runInThisContext(fs.readFileSync(path.join(__dirname, 'fixtures', 'AutoBox-1.0.0.jsx'), 'utf8'));
  const v1 = globalThis.AUTOBOX_TEST.api;
  const comp = host.newComp();
  const ctrl = comp.layers.addNull({ name: 'Ctrl', position: [100, 100] });
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  sub.parent = ctrl; // 1.0 kept a member's own parent and tracked it by name
  comp.select(title, sub);
  v1.createBox(Object.assign({}, v1.DEFAULTS, { layout: 2, padding: 20, fillColor: [1, 0, 0] }));
  const box = comp.layer('AutoBox 1');
  const names = () => box.contentsState.children[0].children[0].children.map((c) => c.name);
  assert.deepEqual(names(), ['Box Rect', 'Stroke 1', 'Fill 1']);
  bounds(sub.compBounds(), 200, 326, 500, 362, '1.0 stacked it');
  host.alerts.length = 0;

  comp.select(box);
  host.api.applySettings(settings(host, { padding: 99, fillType: 2, layout: 3 }));
  assert.equal(host.alerts.length, 1);
  assert.match(host.alerts[0], /Upgraded to AutoBox 2\.0\.0[\s\S]*AutoBox 1 \(now parented to it: Subtitle\)/);
  assert.deepEqual(names(), ['Box Rect', 'Stroke', 'Fill', 'Linear Gradient Fill', 'Radial Gradient Fill'], '1.0 fill and stroke replaced');
  near(box.effectValue('Padding'), 20, 'its own settings are kept');
  near(box.effectValue('Layout'), 2);
  near(box.effectValue('Fill Type'), 1);
  near(box.effectValue('Fill Color 2'), [1, 0, 0, 1], 'new colors seeded from its own');
  assert.equal(sub.parent, box);
  assert.deepEqual(rigExpressions(comp).filter((n) => /Subtitle|Title/.test(n)).length, 2);
  bounds(sub.compBounds(), 200, 326, 500, 362, 'still in its slot');
  near(item(box, 'AutoBox', 'Fill')('ADBE Vector Fill Color').value, [1, 0, 0, 1]);
  comp._layers.forEach((l) => {
    const walk = (st) => {
      assert.ok(!/AB_M\.push/.test(st.expression || ''), `${l.name} > ${st.name} still runs the 1.0 engine`);
      st.children.forEach(walk);
    };
    walk(l.root);
  });

  host.alerts.length = 0;
  host.api.applySettings(settings(host, { padding: 99, fillType: 2, layout: 3 }));
  assert.deepEqual(host.alerts, []);
  near(box.effectValue('Padding'), 99, 'the second Apply pushes the panel settings');
  near(item(box, 'AutoBox', 'Linear Gradient Fill')('ADBE Vector Fill Opacity').value, 100);
});

test('Create Box keeps a shared parent (a controller null) and asks before cutting other links', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const ctrl = comp.layers.addNull({ name: 'Ctrl', position: [50, 50] });
  title.parent = ctrl;
  sub.parent = ctrl;
  const box = create(host, comp, [title, sub]);
  assert.equal(host.confirms.length, 0);
  assert.equal(box.parent, ctrl, 'the box takes over the shared parent');
  assert.equal(title.parent, box);
  bounds(box.boxCompBounds(), 168, 218, 632, 418);
  ctrl.tprop('ADBE Position').setValue([150, 50, 0]);
  bounds(box.boxCompBounds(), 268, 218, 732, 418, 'the controller still moves everything');
  bounds(title.compBounds(), 300, 250, 700, 310);

  const other = comp.layers.addText('Other', { position: [700, 700], rect: { left: 0, top: -20, width: 100, height: 24 } });
  const ctrl2 = comp.layers.addNull({ name: 'Ctrl 2' });
  other.parent = ctrl2;
  const lone = comp.layers.addText('Lone', { position: [700, 800], rect: { left: 0, top: -20, width: 100, height: 24 } });
  host.confirmAnswer = false;
  comp.select(other, lone);
  host.api.createBox(settings(host));
  assert.equal(host.confirms.length, 1);
  assert.match(host.confirms[0], /Other \(parented to Ctrl 2\)/);
  assert.equal(other.parent, ctrl2, 'cancel leaves everything alone');
  assert.equal(comp._layers.filter((l) => /^AutoBox \d+$/.test(l.name)).length, 1);
});

test('boxing layers that sit in a stacked box nests the new box in it, without jumps', () => {
  const host = createHost();
  const comp = host.newComp();
  const cap = comp.layers.addText('Caption', { position: [200, 460], rect: { left: 0, top: -20, width: 200, height: 24 } });
  const sub = comp.layers.addText('Subtitle', { position: [220, 380], rect: { left: 0, top: -30, width: 300, height: 36 } });
  const title = comp.layers.addText('Title', { position: [200, 300], rect: { left: 0, top: -50, width: 400, height: 60 } });
  const card = create(host, comp, [title, sub, cap], { layout: 2 });
  const before = { sub: sub.compBounds(), cap: cap.compBounds() };
  // A Free box first: nothing should move.
  comp.select(sub, cap);
  host.api.createBox(settings(host, { padding: 10 }));
  assert.deepEqual(host.alerts, []);
  assert.equal(host.confirms.length, 0, 'sharing the card as parent needs no confirmation');
  const row = comp.layer('AutoBox 2');
  assert.equal(row.parent, card, 'the new box is nested in the card');
  assert.ok(row.index < card.index && row.index > sub.index, 'between its members and the card');
  assert.match(row.tprop('ADBE Position').expression, /^\/\/ AutoBox member/, 'it takes a slot in the card');
  // The card's stack now holds Title and the row box; the row keeps its layers' layout.
  const rb = row.boxCompBounds(), tb = title.compBounds(), cb = card.boxCompBounds();
  near(rb.t, tb.b + 16, 'row sits one gap below the title');
  near(sub.compBounds().t - rb.t, before.sub.t - (before.sub.t - 10), 'row padding above the subtitle');
  near(cb.b, rb.b + 32, 'card wraps the row');
});

test('a hidden stack member with visible children keeps its spot', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const dot = comp.layers.addShapeMember('Dot', { position: [180, 400], rect: { left: -5, top: -5, width: 10, height: 10 } });
  dot.parent = sub;
  const box = create(host, comp, [title, sub, dot], { layout: 2 });
  const d0 = dot.compBounds(), b0 = box.boxCompBounds();
  sub.enabled = false;
  const b1 = box.boxCompBounds();
  near(b1.b - b1.t, b0.b - b0.t - 36 - 16, 'the hidden member takes no space');
  const d1 = dot.compBounds();
  near(d1.t, d0.t, 'its visible child stays put');
  near(d1.l, d0.l);
});

test('Apply to Box leaves animated controls alone', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title]);
  const pad = new Prop(box.effectsState.children.find((e) => e.name === 'Padding').children[0]);
  pad.setValueAtTime(0, 10);
  pad.setValueAtTime(1, 50);
  comp.time = 2;
  comp.select(box);
  host.api.applySettings(settings(host, { padding: 99, radius: 3 }));
  assert.equal(pad.numKeys, 2, 'no stray keyframe');
  near(pad.valueAtTime(0, true), 10);
  near(box.effectValue('Corner Radius'), 3, 'other controls still update');
});

test('deleting a box leaves no stray stroke layer behind for long', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const box = create(host, comp, [title]);
  const orphan = comp.layer('AutoBox 1 Stroke');
  box.remove();
  assert.equal(orphan.parent, null);
  create(host, comp, [sub]);
  assert.ok(!comp._layers.includes(orphan), 'orphaned stroke layer cleaned up');
  assert.equal(comp._layers.filter((l) => /Stroke$/.test(l.name)).length, 1, 'only the new box has one');
});

test('selecting a box with its stroke layer to nest it raises no alert', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const inner = create(host, comp, [title]);
  comp.select(inner, comp.layer('AutoBox 1 Stroke'), sub);
  host.api.createBox(settings(host, { layout: 2 }));
  assert.deepEqual(host.alerts, []);
  assert.equal(inner.parent, comp.layer('AutoBox 2'));
  assert.equal(comp.layer('AutoBox 1 Stroke').parent, inner);
});

test('a released nested box still counts its stroke in the outer stack', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  const inner = create(host, comp, [title], { padding: 10, strokeWidth: 20 });
  const outer = create(host, comp, [inner, sub], { layout: 2, padding: 20, gap: 8 });
  const before = sub.compBounds();
  comp.select(inner);
  host.api.releaseBoxes();
  bounds(sub.compBounds(), before.l, before.t, before.r, before.b, 'nothing shifts');
  assert.ok(outer);
});

test('every expression AutoBox writes is plain ES3 (Legacy ExtendScript engine)', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.tprop('ADBE Position').dimensionsSeparated = true;
  create(host, comp, [title, sub], { layout: 2, fillType: 2, strokeType: 3, strokeWidth: 4 });
  let count = 0;
  const walk = (l, st) => {
    if (st.expression) {
      count++;
      assert.doesNotThrow(() => acorn.parse(st.expression, { ecmaVersion: 3 }), `${l.name} > ${st.name}`);
    }
    st.children.forEach((c) => walk(l, c));
  };
  comp._layers.forEach((l) => walk(l, l.root));
  assert.ok(count > 30, `checked ${count} expressions`);
});

test('a layer with its own position expression is reported, not silently left behind', () => {
  const host = createHost();
  const { comp, title, sub } = scene(host);
  sub.tprop('ADBE Position').expression = 'value;';
  comp.select(title, sub);
  host.api.createBox(settings(host, { layout: 2 }));
  assert.equal(host.alerts.length, 1);
  assert.match(host.alerts[0], /already have an expression on Position[\s\S]*Subtitle/);
  assert.equal(sub.tprop('ADBE Position').expression, 'value;', 'their expression is kept');
});
