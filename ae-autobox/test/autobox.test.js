'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const acorn = require('acorn');
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

function rigExpressions(comp) {
  const out = [];
  const walk = (s) => {
    if (s.expression && s.expression.indexOf('// AutoBox') === 0) out.push(s);
    s.children.forEach(walk);
  };
  comp._layers.forEach((l) => walk(l.root));
  return out;
}

test('script and generated expressions are plain ES3 (Legacy ExtendScript engine)', () => {
  const host = createHost();
  acorn.parse(fs.readFileSync(SCRIPT_PATH, 'utf8'), { ecmaVersion: 3 });
  const members = [{ name: 'Title "quoted" \\ name', ext: false }, { name: 'Icon', ext: true }];
  for (const kind of ['size', 'position', 'roundness', 'member', 'memberX', 'memberY']) {
    acorn.parse(host.api.buildExpression(kind, 'AutoBox 1', members), { ecmaVersion: 3 });
  }
});

test('the engine only reads controls that every box gets', () => {
  const host = createHost();
  const expr = host.api.buildExpression('size', null, []);
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
  assert.deepEqual(comp._layers.map((l) => l.name), ['Title', 'Subtitle', 'AutoBox 1'], 'box sits behind its layers');
  assert.equal(title.parent, box);
  assert.equal(sub.parent, box);
  bounds(title.compBounds(), 200, 250, 600, 310, 'title unchanged');
  bounds(sub.compBounds(), 220, 350, 520, 386, 'subtitle unchanged');
  bounds(box.boxCompBounds(), 168, 218, 632, 418, 'box = union + 32px padding');
  near(box.tprop('ADBE Position').value.slice(0, 2), [168, 218], 'box layer sits on its top-left anchor');
  near(box.boxRect().roundness, 16, 'corner radius');
  near(box.effectValue('Ignore Hidden'), 1);
  near(box.effectValue('Layout'), 1);
  assert.deepEqual(box.effectsState.children.map((e) => e.name), host.api.CONTROLS.map((c) => c.name));
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

test('fill and stroke follow the Effect Controls', () => {
  const host = createHost();
  const { comp, title } = scene(host);
  const box = create(host, comp, [title], { fillColor: [1, 0.5, 0], strokeWidth: 0 });
  const g = box.rectShapes()[0].parent;
  const fill = g.children.find((c) => c.matchName === 'ADBE Vector Graphic - Fill');
  const stroke = g.children.find((c) => c.matchName === 'ADBE Vector Graphic - Stroke');
  near(new Prop(fill.children[0]).value, [1, 0.5, 0, 1]);
  near(new Prop(stroke.children[1]).value, 0, 'no stroke at width 0');
  box.setEffect('Stroke Width', 4);
  near(new Prop(stroke.children[1]).value, 100);
  near(new Prop(stroke.children[2]).value, 4);
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
  assert.deepEqual(box.effectsState.children.map((e) => e.name), ['Fill Color', 'Fill Opacity', 'Stroke Width', 'Stroke Color']);
  assert.equal(box.contentsState.children[0].name, 'Box');
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

test('members get unique, explicit names so expressions can find them', () => {
  const host = createHost();
  const comp = host.newComp();
  const a = comp.layers.addText('Hello', { isNameSet: false, position: [100, 100], rect: { left: 0, top: -20, width: 100, height: 24 } });
  const b = comp.layers.addText('Hello', { isNameSet: false, position: [100, 200], rect: { left: 0, top: -20, width: 100, height: 24 } });
  const box = create(host, comp, [a, b]);
  assert.notEqual(a.name, b.name);
  assert.ok(a.isNameSet && b.isNameSet);
  bounds(box.boxCompBounds(), 68, 48, 232, 236);
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

  comp.select(title, sub);
  host.api.createBox(settings(host));
  assert.match(host.alerts[0], /Title — already in AutoBox 1/);
  assert.equal(comp._layers.filter((l) => l.name.indexOf('AutoBox') === 0).length, 2);
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

  const swatch = panel2.find((c) => c.type === 'button' && c.helpTip === 'Fill color');
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
