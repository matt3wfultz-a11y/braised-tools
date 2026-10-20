// A small After Effects mock — just enough of the scripting DOM, the
// expression runtime and ScriptUI to drive AutoBox.jsx from Node.
//
// It is deliberately strict where After Effects is: property references go
// stale ("Object is invalid") when their parent group gains or loses a child,
// a missing layer or effect throws inside expressions, and expression cycles
// throw instead of silently resolving.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.join(__dirname, '..', 'AutoBox.jsx');
const KEY_LINEAR = 6612;
const KEY_HOLD = 6614;
const TRACK_MATTE = { NO_TRACK_MATTE: 5012, ALPHA: 5013, ALPHA_INVERTED: 5014, LUMA: 5015, LUMA_INVERTED: 5016 };
// Track mattes by layer (setTrackMatte) arrived in After Effects 23.0.
const features = { setTrackMatte: true };

function clone(v) {
  return Array.isArray(v) ? v.slice() : v;
}

function lerp(a, b, f) {
  if (Array.isArray(a)) return a.map((x, i) => x + (b[i] - x) * f);
  return a + (b - a) * f;
}

// ---------------------------------------------------------------------------
// Expression runtime
// ---------------------------------------------------------------------------
const evalStack = [];
let nextId = 1;

function runExpression(code, thisLayer, thisComp, thisProperty, time, value) {
  const effect = (n) => thisLayer.effect(n);
  // Direct eval returns the completion value of the last statement, which is
  // how After Effects picks an expression's result.
  return (function (thisLayer, thisComp, thisProperty, time, value, effect) {
    return eval(code);
  })(thisLayer, thisComp, thisProperty, time, value, effect);
}

// An expression-side property or group: call it with a name, match name or
// 1-based index to reach a child; .value reads it at the evaluation time.
function exprProp(state, t) {
  const f = (key) => {
    const c = typeof key === 'number' ? state.children[key - 1] : state.children.find((ch) => ch.name === key || ch.matchName === key);
    if (!c) throw new Error(`Property "${key}" is missing in ${state.name}`);
    return exprProp(c, t);
  };
  // Like After Effects, 2D layer properties read as 2D in expressions.
  const trim = (v) => (state.exprDims && Array.isArray(v) ? v.slice(0, state.exprDims) : v);
  Object.defineProperty(f, 'value', { configurable: true, get: () => trim(new Prop(state).valueAtTime(t, false)) });
  f.valueAtTime = (t2) => trim(new Prop(state).valueAtTime(t2, false));
  Object.defineProperty(f, 'numKeys', { get: () => state.keys.length });
  f.key = (i) => {
    const k = state.keys[i - 1];
    if (!k) throw new Error(`Key ${i} is out of range in ${state.name}`);
    return { time: k.t, value: trim(clone(k.v)), index: i };
  };
  Object.defineProperty(f, 'numProperties', { get: () => state.children.length });
  f.propertyGroup = (n = 1) => {
    let s = state;
    for (let i = 0; i < n; i++) s = s.parent;
    return exprProp(s, t);
  };
  // Shape groups: content(nameOrIndex) reaches into the group's Contents.
  if (state.matchName === 'ADBE Vector Group') f.content = (key) => f('ADBE Vectors Group')(key);
  if (state.matchName === 'ADBE Vector Shape - Rect') {
    ['size', 'position', 'roundness'].forEach((attr, i) => {
      Object.defineProperty(f, attr, { get: () => exprProp(state.children[i], t) });
    });
  }
  return f;
}

function evaluate(state, t, base) {
  const key = `${state.id}@${t}`;
  if (evalStack.includes(key)) {
    throw new Error(`Expression cycle through ${state.layer.name} › ${state.name}`);
  }
  evalStack.push(key);
  try {
    const layer = state.layer;
    const exprValue = state.exprDims && Array.isArray(base) ? base.slice(0, state.exprDims) : base;
    let out = runExpression(state.expression, exprLayer(layer, t), new ExprComp(layer.comp, t), exprProp(state, t), t, exprValue);
    if (typeof out === 'boolean') out = out ? 1 : 0;
    if (Array.isArray(out)) {
      out = Array.from(out);
      if (Array.isArray(base)) while (out.length < base.length) out.push(base[out.length]);
      if (out.some((x) => typeof x !== 'number' || Number.isNaN(x))) {
        throw new Error(`Expression result is not numeric: ${JSON.stringify(out)}`);
      }
    } else if (typeof out !== 'number' || Number.isNaN(out)) {
      throw new Error(`Expression result is not numeric: ${out}`);
    }
    state.expressionError = '';
    return out;
  } catch (err) {
    state.expressionError = err.message;
    throw err;
  } finally {
    evalStack.pop();
  }
}

class ExprComp {
  constructor(comp, t) {
    this._c = comp;
    this._t = t;
  }
  get numLayers() { return this._c._layers.length; }
  get frameDuration() { return this._c.frameDuration; }
  get duration() { return this._c.duration; }
  layer(key) {
    const l = typeof key === 'number' ? this._c._layers[key - 1] : this._c._layers.find((x) => x.name === key);
    if (!l) throw new Error(`Layer "${key}" is missing or does not exist`);
    return exprLayer(l, this._t);
  }
}

// Like After Effects, a layer can be called with a match name to reach its
// property groups: L("ADBE Text Properties")("ADBE Text Animators").
function exprLayer(layer, t) {
  const f = (key) => exprProp(layer.root, t)(key);
  Object.setPrototypeOf(f, ExprLayer.prototype);
  Object.defineProperty(f, 'name', { get: () => layer.name });
  f._l = layer;
  f._t = t;
  return f;
}

class ExprLayer {
  get index() { return this._l.index; }
  get name() { return this._l.name; }
  get enabled() { return this._l.enabled; }
  get inPoint() { return this._l.inPoint; }
  get outPoint() { return this._l.outPoint; }
  get startTime() { return this._l.startTime; }
  get hasParent() { return !!this._l.parent; }
  get parent() {
    if (!this._l.parent) throw new Error(`${this._l.name} has no parent`);
    return exprLayer(this._l.parent, this._t);
  }
  get active() {
    const l = this._l;
    return l.enabled && this._t >= l.inPoint && this._t < l.outPoint;
  }
  // Cameras and lights have a video switch too, so hasVideo doesn't filter them out.
  get hasVideo() { return this._l instanceof CameraLayer ? true : this._l.hasVideo; }
  get text() {
    if (!(this._l instanceof TextLayer)) return undefined;
    const l = this._l;
    const sourceText = {
      value: l.sourceText,
      valueAtTime: () => l.sourceText,
      get numKeys() { return l.textKeys.length; },
      key(i) {
        if (i < 1 || i > l.textKeys.length) throw new Error(`Key ${i} is out of range in Source Text`);
        return { time: l.textKeys[i - 1], value: l.sourceText, index: i };
      },
    };
    return { sourceText };
  }
  get transform() {
    const l = this._l, t = this._t;
    if (l instanceof CameraLayer) {
      const missing = () => { throw new Error('Camera has no anchorPoint/scale'); };
      return { get anchorPoint() { return missing(); }, get scale() { return missing(); },
        position: { get value() { return l.positionAt(t); } }, rotation: { value: 0 } };
    }
    const get = (mn) => exprProp(l.tprop(mn).s, t);
    // Position reads X/Y Position when its dimensions are separated.
    const position = get('ADBE Position');
    Object.defineProperty(position, 'value', { get: () => l.positionAt(t) });
    position.valueAtTime = (t2) => l.positionAt(t2);
    const separated = () => {
      if (!l.tprop('ADBE Position').dimensionsSeparated) throw new Error('X Position is only there when Position is separated');
    };
    return {
      anchorPoint: get('ADBE Anchor Point'),
      scale: get('ADBE Scale'),
      position,
      get xPosition() { separated(); return get('ADBE Position_0'); },
      get yPosition() { separated(); return get('ADBE Position_1'); },
      rotation: get('ADBE Rotate Z'),
      opacity: get('ADBE Opacity'),
    };
  }
  content(key) {
    if (!(this._l instanceof ShapeLayer)) throw new Error(`${this._l.name} has no content()`);
    return exprProp(this._l.contentsState, this._t)(key);
  }
  // Like After Effects, t is read as the layer's own time: a layer that
  // starts at 1s answers for comp time t + 1. sourceTime(t) converts.
  sourceRectAtTime(t = this.sourceTime(this._t), ext = false) {
    if (this._l instanceof CameraLayer) throw new Error('Camera has no sourceRectAtTime');
    return this._l.sourceRectAtTime(t + this._l.startTime, ext);
  }
  sourceTime(t = this._t) { return t - this._l.startTime; }
  toComp(p, t = this._t) { return this._l.toCompAt(t, p); }
  fromComp(p, t = this._t) { return this._l.fromCompAt(t, p); }
  effect(name) {
    const e = this._l.effectsState.children.find((c) => c.name === name);
    if (!e) throw new Error(`Effect "${name}" is missing`);
    return (i) => exprProp(e.children[i - 1], this._t);
  }
}

// ---------------------------------------------------------------------------
// Properties and property groups
// ---------------------------------------------------------------------------
class PState {
  constructor(o) {
    Object.assign(this, {
      id: nextId++, name: '', matchName: '', group: false, children: [], value: 0, keys: [],
      expression: '', expressionEnabled: true, expressionError: '', gen: 0, parent: null,
      layer: null, spatial: false, dimensionsSeparated: false, items: null, removed: false,
      exprDims: 0, interp: [], enabled: true, holdOnly: false,
    }, o);
  }
  add(child) {
    child.parent = this;
    child.layer = this.layer;
    this.children.push(child);
    setLayer(child, this.layer);
    return child;
  }
}

function cloneState(state, parent, layer) {
  const c = new PState(Object.assign({}, state, { id: nextId++, parent, layer, children: [], gen: 0 }));
  c.value = clone(state.value);
  c.keys = state.keys.map((k) => ({ t: k.t, v: clone(k.v) }));
  c.items = state.items ? state.items.slice() : null;
  c.children = state.children.map((ch) => cloneState(ch, c, layer));
  return c;
}

function setLayer(state, layer) {
  state.layer = layer;
  state.children.forEach((c) => setLayer(c, layer));
}

function prop(name, matchName, value, extra) {
  return new PState(Object.assign({ name, matchName, value }, extra));
}

function group(name, matchName, children) {
  const g = new PState({ name, matchName, group: true });
  (children || []).forEach((c) => g.add(c));
  return g;
}

// Keys are { t, v, hold, ease }: `ease` maps the segment that starts at the
// key (0..1 -> progress, may overshoot); `hold` keeps the value until the next
// key. Checkbox and menu controls only have hold keys, like in After Effects.
function staticAt(s, t) {
  if (!s.keys.length) return clone(s.value);
  const k = s.keys;
  if (t <= k[0].t) return clone(k[0].v);
  if (t >= k[k.length - 1].t) return clone(k[k.length - 1].v);
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i].t && t < k[i + 1].t) {
      if (k[i].hold || s.holdOnly) return clone(k[i].v);
      const f = (t - k[i].t) / (k[i + 1].t - k[i].t);
      return lerp(k[i].v, k[i + 1].v, k[i].ease ? k[i].ease(f) : f);
    }
  }
  return clone(k[k.length - 1].v);
}

function inShapeContents(s) {
  for (let p = s.parent; p; p = p.parent) if (p.matchName === 'ADBE Root Vectors Group') return true;
  return false;
}

// Like After Effects, scripts can't change anything on a locked layer.
function editable(s) {
  const layer = s && s.layer;
  if (layer && layer.locked) throw new Error(`After Effects error: ${layer.name} is locked`);
  return s;
}

// Adding, removing or moving a property checks the layer the way After
// Effects does after a shape item was moved (see Prop.moveTo).
function verified(s) {
  const layer = s.layer;
  if (layer && layer._brokenStream) {
    const msg = layer._brokenStream;
    layer._brokenStream = null;
    throw new Error(`After Effects error: internal verification failure, sorry! {${msg}}`);
  }
  return s;
}

class Prop {
  constructor(state) {
    this.s = state;
    this.parentGen = state.parent ? state.parent.gen : 0;
  }
  _c() {
    const s = this.s;
    if (s.removed) throw new Error(`Object is invalid (${s.name} was removed)`);
    if (s.parent && s.parent.gen !== this.parentGen) throw new Error(`Object is invalid (stale reference to ${s.name})`);
    return s;
  }
  get name() { return this._c().name; }
  set name(v) { this._c().name = String(v); }
  get matchName() { return this._c().matchName; }
  get numProperties() { return this._c().children.length; }
  get propertyIndex() { const s = this._c(); return s.parent.children.indexOf(s) + 1; }
  property(key) {
    const s = this._c();
    const c = typeof key === 'number' ? s.children[key - 1] : s.children.find((ch) => ch.name === key || ch.matchName === key);
    return c ? new Prop(c) : null;
  }
  propertyGroup(n = 1) {
    let s = this._c();
    for (let i = 0; i < n; i++) s = s.parent;
    return new Prop(s);
  }
  addProperty(matchName) {
    const s = verified(editable(this._c()));
    const make = FACTORIES[matchName];
    if (!make) throw new Error(`Can't add ${matchName} here`);
    const child = s.add(make(s));
    s.gen++;
    return new Prop(child);
  }
  remove() {
    const s = verified(editable(this._c()));
    s.parent.children.splice(s.parent.children.indexOf(s), 1);
    s.parent.gen++;
    s.removed = true;
  }
  // Like After Effects, moving an item invalidates references to its siblings.
  // Moving a shape item also leaves After Effects' own references to the
  // siblings it shifted pointing at the wrong item, and the next edit to the
  // layer fails an internal check (reported from After Effects as "internal
  // verification failure, sorry! {stream at index matchName=...}").
  moveTo(index) {
    const s = verified(this._c()), list = s.parent.children;
    if (index < 1 || index > list.length) throw new Error(`moveTo(${index}) out of range`);
    const before = list.slice();
    list.splice(list.indexOf(s), 1);
    list.splice(index - 1, 0, s);
    s.parent.gen++;
    const shifted = before.find((c, i) => c !== s && list[i] !== c);
    if (shifted && inShapeContents(s) && s.layer) {
      s.layer._brokenStream = `stream at index matchName="${shifted.matchName}" ` +
        `(mismatch with resultP, expected "${list[before.indexOf(shifted)].matchName}")`;
    }
  }
  // The eyeball / fx switch of shape items, masks and effects.
  get canSetEnabled() {
    const s = this._c();
    return /^ADBE Vector (Graphic|Shape|Group|Filter)/.test(s.matchName) || (!!s.parent && s.parent.matchName === 'ADBE Effect Parade');
  }
  get enabled() { return this._c().enabled; }
  set enabled(v) {
    if (!this.canSetEnabled) throw new Error(`Can't set enabled on ${this._c().name}`);
    this._c().enabled = !!v;
  }
  get canSetExpression() { return !this._c().group && !this._c().noValue; }
  get expression() { return this._c().expression; }
  set expression(v) {
    const s = editable(this._c());
    if (s.noValue) throw new Error(`${s.name} can't have an expression`);
    s.expression = String(v);
    s.expressionError = '';
  }
  get expressionEnabled() { return this._c().expressionEnabled; }
  set expressionEnabled(v) { this._c().expressionEnabled = !!v; }
  get expressionError() { return this._c().expressionError; }
  get isSpatial() { return this._c().spatial; }
  get numKeys() { return this._c().keys.length; }
  get value() { return this.valueAtTime(this._c().layer.comp.time, false); }
  valueAtTime(t, pre) {
    const s = this._c();
    if (s.noValue) throw new Error(`${s.name} has no value scripts can read`);
    const base = staticAt(s, t);
    if (pre || !s.expression || !s.expressionEnabled) return base;
    return evaluate(s, t, base);
  }
  _check(v) {
    const s = this._c();
    if (s.noValue) throw new Error(`${s.name} has no value that scripts can set`);
    if (Array.isArray(s.value) !== Array.isArray(v)) throw new Error(`Bad value for ${s.name}: ${JSON.stringify(v)}`);
    if (s.items && (v < 1 || v > s.items.length || v !== Math.round(v))) throw new Error(`Menu value ${v} out of range`);
    if (Array.isArray(v)) {
      const out = v.slice();
      while (out.length < s.value.length) out.push(s.value[out.length]);
      return out.slice(0, s.value.length);
    }
    return v;
  }
  setValue(v) {
    const s = editable(this._c());
    if (s.keys.length) throw new Error(`Can't setValue on keyframed ${s.name}`);
    s.value = this._check(v);
  }
  setValueAtTime(t, v) {
    const s = editable(this._c());
    const val = this._check(v);
    const k = s.keys.find((x) => Math.abs(x.t - t) < 1e-9);
    if (k) k.v = val;
    else s.keys.push({ t, v: val });
    s.keys.sort((a, b) => a.t - b.t);
  }
  setValuesAtTimes(ts, vs) {
    ts.forEach((t, i) => this.setValueAtTime(t, vs[i]));
  }
  removeKey(i) {
    const s = editable(this._c());
    if (i < 1 || i > s.keys.length) throw new Error(`No key ${i}`);
    s.keys.splice(i - 1, 1);
  }
  keyTime(i) { return this._c().keys[i - 1].t; }
  keyValue(i) { return clone(this._c().keys[i - 1].v); }
  setInterpolationTypeAtKey(i, inType, outType) {
    const s = this._key(i);
    s.keys[i - 1].hold = (outType === undefined ? inType : outType) === KEY_HOLD;
  }
  keyInInterpolationType(i) { return this.keyOutInterpolationType(i); }
  keyOutInterpolationType(i) { return this._key(i).holdOnly || this._c().keys[i - 1].hold ? KEY_HOLD : KEY_LINEAR; }
  setSpatialAutoBezierAtKey(i) { this._key(i); }
  setSpatialContinuousAtKey(i) { this._key(i); }
  setSpatialTangentsAtKey(i, a, b) {
    const s = this._key(i);
    if (!s.spatial) throw new Error('Not spatial');
    if (a.length !== s.value.length || b.length !== s.value.length) throw new Error('Tangent dimension mismatch');
  }
  _key(i) {
    const s = this._c();
    if (i < 1 || i > s.keys.length) throw new Error(`No key ${i}`);
    return s;
  }
  get dimensionsSeparated() { return this._c().dimensionsSeparated; }
  set dimensionsSeparated(v) {
    const s = this._c();
    const tr = s.parent;
    const x = tr.children.find((c) => c.matchName === 'ADBE Position_0');
    const y = tr.children.find((c) => c.matchName === 'ADBE Position_1');
    if (v && !s.dimensionsSeparated) { x.value = s.value[0]; y.value = s.value[1]; }
    if (!v && s.dimensionsSeparated) { s.value = [x.value, y.value, s.value[2]]; }
    s.dimensionsSeparated = !!v;
  }
  setPropertyParameters(items) {
    const s = this._c();
    if (!s.parent || s.parent.matchName !== 'ADBE Dropdown Control') throw new Error('Not a dropdown menu');
    s.items = items.slice();
    s.value = 1;
    // After Effects invalidates the effect reference here.
    s.parent.parent.gen++;
    return new Prop(s);
  }
}

// ---------------------------------------------------------------------------
// Things that can be added with addProperty
// ---------------------------------------------------------------------------
function effect(name, matchName, ctlName, value, extra) {
  return () => group(name, matchName, [prop(ctlName, `${matchName}-0001`, value, extra)]);
}

const FACTORIES = {
  'ADBE Slider Control': effect('Slider Control', 'ADBE Slider Control', 'Slider', 0),
  'ADBE Checkbox Control': effect('Checkbox Control', 'ADBE Checkbox Control', 'Checkbox', 0, { holdOnly: true }),
  'ADBE Color Control': effect('Color Control', 'ADBE Color Control', 'Color', [1, 0, 0, 1]),
  'ADBE Point Control': effect('Point Control', 'ADBE Point Control', 'Point', [0, 0]),
  'ADBE Angle Control': effect('Angle Control', 'ADBE Angle Control', 'Angle', 0),
  'ADBE Dropdown Control': effect('Dropdown Menu Control', 'ADBE Dropdown Control', 'Menu', 1, { items: ['Item 1', 'Item 2', 'Item 3'], holdOnly: true }),
  'ADBE Vector Group': () => group('Group 1', 'ADBE Vector Group', [
    group('Contents', 'ADBE Vectors Group'),
    group('Transform', 'ADBE Vector Transform Group'),
  ]),
  'ADBE Vector Shape - Rect': () => group('Rectangle Path 1', 'ADBE Vector Shape - Rect', [
    prop('Size', 'ADBE Vector Rect Size', [100, 100]),
    prop('Position', 'ADBE Vector Rect Position', [0, 0], { spatial: true }),
    prop('Roundness', 'ADBE Vector Rect Roundness', 0),
  ]),
  'ADBE Vector Graphic - Fill': () => group('Fill 1', 'ADBE Vector Graphic - Fill', [
    prop('Color', 'ADBE Vector Fill Color', [1, 0, 0, 1]),
    prop('Opacity', 'ADBE Vector Fill Opacity', 100),
  ]),
  // Gradient colors aren't readable or settable from scripts (NO_VALUE).
  'ADBE Vector Graphic - G-Fill': () => group('Gradient Fill 1', 'ADBE Vector Graphic - G-Fill', [
    prop('Type', 'ADBE Vector Grad Type', 1),
    prop('Start Point', 'ADBE Vector Grad Start Pt', [0, 0], { spatial: true }),
    prop('End Point', 'ADBE Vector Grad End Pt', [100, 0], { spatial: true }),
    prop('Highlight Length', 'ADBE Vector Grad HiLite Length', 0),
    prop('Highlight Angle', 'ADBE Vector Grad HiLite Angle', 0),
    prop('Colors', 'ADBE Vector Grad Colors', null, { noValue: true }),
    prop('Opacity', 'ADBE Vector Fill Opacity', 100),
  ]),
  'ADBE Vector Graphic - G-Stroke': () => group('Gradient Stroke 1', 'ADBE Vector Graphic - G-Stroke', [
    prop('Type', 'ADBE Vector Grad Type', 1),
    prop('Start Point', 'ADBE Vector Grad Start Pt', [0, 0], { spatial: true }),
    prop('End Point', 'ADBE Vector Grad End Pt', [100, 0], { spatial: true }),
    prop('Highlight Length', 'ADBE Vector Grad HiLite Length', 0),
    prop('Highlight Angle', 'ADBE Vector Grad HiLite Angle', 0),
    prop('Colors', 'ADBE Vector Grad Colors', null, { noValue: true }),
    prop('Opacity', 'ADBE Vector Stroke Opacity', 100),
    prop('Stroke Width', 'ADBE Vector Stroke Width', 2),
  ]),
  'ADBE Tint': () => group('Tint', 'ADBE Tint', [
    prop('Map Black To', 'ADBE Tint-0001', [0, 0, 0, 1]),
    prop('Map White To', 'ADBE Tint-0002', [1, 1, 1, 1]),
    prop('Amount to Tint', 'ADBE Tint-0003', 100),
  ]),
  'ADBE Vector Graphic - Stroke': () => group('Stroke 1', 'ADBE Vector Graphic - Stroke', [
    prop('Color', 'ADBE Vector Stroke Color', [1, 1, 1, 1]),
    prop('Opacity', 'ADBE Vector Stroke Opacity', 100),
    prop('Stroke Width', 'ADBE Vector Stroke Width', 2),
  ]),
};

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
function rotate(x, y, deg) {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

class Layer {
  constructor(comp, o = {}) {
    this.comp = comp;
    this._name = o.name || 'Layer';
    this.isNameSet = o.isNameSet !== false;
    this.enabled = true;
    this.locked = false;
    this.inPoint = o.inPoint !== undefined ? o.inPoint : 0;
    this.outPoint = o.outPoint !== undefined ? o.outPoint : comp.duration;
    this.startTime = 0;
    this.hasVideo = o.hasVideo !== undefined ? o.hasVideo : true;
    this.nullLayer = !!o.nullLayer;
    this.adjustmentLayer = !!o.adjustmentLayer;
    this.selected = false;
    this.comment = '';
    this.label = 0;
    this.motionBlur = false;
    this._parent = null;
    this.rect = o.rect || { left: 0, top: 0, width: 100, height: 100 };
    const p = o.position || [0, 0];
    this.root = group('Layer', 'Layer');
    this.root.layer = this;
    this.root.add(group('Transform', 'ADBE Transform Group', [
      prop('Anchor Point', 'ADBE Anchor Point', (o.anchor || [0, 0]).concat([0]), { exprDims: 2 }),
      prop('Position', 'ADBE Position', [p[0], p[1], 0], { spatial: true, exprDims: 2 }),
      prop('X Position', 'ADBE Position_0', p[0]),
      prop('Y Position', 'ADBE Position_1', p[1]),
      prop('Scale', 'ADBE Scale', (o.scale || [100, 100]).concat([100]), { exprDims: 2 }),
      prop('Rotation', 'ADBE Rotate Z', o.rotation || 0),
      prop('Opacity', 'ADBE Opacity', 100),
    ]));
    this.effectsState = this.root.add(group('Effects', 'ADBE Effect Parade'));
  }
  get name() { return this._name; }
  set name(v) {
    this._name = String(v);
    this.isNameSet = true;
  }
  get index() { return this.comp._layers.indexOf(this) + 1; }
  get containingComp() { return this.comp; }
  property(key) {
    const c = this.root.children.find((ch) => ch.name === key || ch.matchName === key);
    return c ? new Prop(c) : null;
  }
  tprop(mn) {
    return new Prop(this.root.children[0].children.find((c) => c.matchName === mn));
  }
  positionAt(t) {
    const pos = this.tprop('ADBE Position');
    if (pos.dimensionsSeparated) {
      return [this.tprop('ADBE Position_0').valueAtTime(t, false), this.tprop('ADBE Position_1').valueAtTime(t, false)];
    }
    return pos.valueAtTime(t, false).slice(0, 2);
  }
  localToParent(t, p) {
    const a = this.tprop('ADBE Anchor Point').valueAtTime(t, false);
    const s = this.tprop('ADBE Scale').valueAtTime(t, false);
    const r = this.tprop('ADBE Rotate Z').valueAtTime(t, false);
    const pos = this.positionAt(t);
    const d = rotate(((p[0] - a[0]) * s[0]) / 100, ((p[1] - a[1]) * s[1]) / 100, r);
    return [pos[0] + d[0], pos[1] + d[1]];
  }
  parentToLocal(t, p) {
    const a = this.tprop('ADBE Anchor Point').valueAtTime(t, false);
    const s = this.tprop('ADBE Scale').valueAtTime(t, false);
    const r = this.tprop('ADBE Rotate Z').valueAtTime(t, false);
    const pos = this.positionAt(t);
    const d = rotate(p[0] - pos[0], p[1] - pos[1], -r);
    return [(d[0] * 100) / s[0] + a[0], (d[1] * 100) / s[1] + a[1]];
  }
  toCompAt(t, p) {
    let q = [p[0], p[1]];
    for (let l = this; l; l = l.parent) q = l.localToParent(t, q);
    return q;
  }
  fromCompAt(t, p) {
    const chain = [];
    for (let l = this; l; l = l.parent) chain.unshift(l);
    let q = [p[0], p[1]];
    chain.forEach((l) => { q = l.parentToLocal(t, q); });
    return q;
  }
  chainRotation(t) {
    let r = 0;
    for (let l = this; l; l = l.parent) r += l.tprop('ADBE Rotate Z').valueAtTime(t, false);
    return r;
  }
  chainScale(t) {
    const s = [1, 1];
    for (let l = this; l; l = l.parent) {
      const v = l.tprop('ADBE Scale').valueAtTime(t, false);
      s[0] *= v[0] / 100;
      s[1] *= v[1] / 100;
    }
    return s;
  }
  get parent() { return this._parent; }
  // Like the parent pick whip: compensate so the layer doesn't jump.
  set parent(p) {
    editable(this.root);
    this._setParent(p);
  }
  _setParent(p) {
    if (p) for (let l = p; l; l = l.parent) if (l === this) throw new Error('Parent cycle');
    const t = this.comp.time, old = this._parent;
    const conv = (v) => {
      const c = old ? old.toCompAt(t, v) : [v[0], v[1]];
      return p ? p.fromCompAt(t, c) : c;
    };
    const pos = this.tprop('ADBE Position');
    if (pos.dimensionsSeparated) {
      const x = this.tprop('ADBE Position_0').s, y = this.tprop('ADBE Position_1').s;
      const v = conv([x.value, y.value]);
      x.value = v[0];
      y.value = v[1];
    } else {
      const s = pos.s;
      const fix = (v) => conv(v).concat([v[2]]);
      s.value = fix(s.value);
      s.keys.forEach((k) => { k.v = fix(k.v); });
    }
    const rot = this.tprop('ADBE Rotate Z').s;
    rot.value += (old ? old.chainRotation(t) : 0) - (p ? p.chainRotation(t) : 0);
    const sc = this.tprop('ADBE Scale').s;
    const so = old ? old.chainScale(t) : [1, 1], sn = p ? p.chainScale(t) : [1, 1];
    sc.value = [(sc.value[0] * so[0]) / sn[0], (sc.value[1] * so[1]) / sn[1], sc.value[2]];
    this._parent = p || null;
  }
  setParentWithJump(p) {
    editable(this.root);
    this._parent = p || null;
  }
  moveAfter(other) {
    const list = this.comp._layers;
    list.splice(list.indexOf(this), 1);
    list.splice(list.indexOf(other) + 1, 0, this);
  }
  moveBefore(other) {
    const list = this.comp._layers;
    list.splice(list.indexOf(this), 1);
    list.splice(list.indexOf(other), 0, this);
  }
  moveToBeginning() {
    const list = this.comp._layers;
    list.splice(list.indexOf(this), 1);
    list.unshift(this);
  }
  remove() {
    editable(this.root);
    this.comp._layers.forEach((l) => {
      if (l._parent === this) l._setParent(null);
      if (l._matte === this) l._matte = null;
    });
    this.comp._layers.splice(this.comp._layers.indexOf(this), 1);
  }
  // Like Edit > Duplicate: the copy lands directly above the original.
  duplicate() {
    const copy = Object.create(Object.getPrototypeOf(this));
    Object.assign(copy, this);
    copy.root = cloneState(this.root, null, copy);
    copy.root.layer = copy;
    copy.effectsState = copy.root.children.find((c) => c.matchName === 'ADBE Effect Parade');
    if (this.contentsState) copy.contentsState = copy.root.children.find((c) => c.matchName === 'ADBE Root Vectors Group');
    copy.selected = false;
    const list = this.comp._layers;
    list.splice(list.indexOf(this), 0, copy);
    return copy;
  }
  sourceRectAtTime(t, ext) {
    const r = typeof this.rect === 'function' ? this.rect(t) : this.rect;
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  // Test helpers
  setText(rect) { this.rect = rect; }
  compBounds(t = this.comp.time) {
    const r = this.sourceRectAtTime(t, false);
    const pts = [[r.left, r.top], [r.left + r.width, r.top], [r.left, r.top + r.height], [r.left + r.width, r.top + r.height]]
      .map((p) => this.toCompAt(t, p));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
  }
  effectValue(name, t = this.comp.time) {
    const e = this.effectsState.children.find((c) => c.name === name);
    return new Prop(e.children[0]).valueAtTime(t, false);
  }
  setEffect(name, v) {
    const e = this.effectsState.children.find((c) => c.name === name);
    if (!e) throw new Error(`No effect ${name}`);
    new Prop(e.children[0]).setValue(v);
  }
}

class AVLayer extends Layer {
  // Like After Effects 23+: any layer can be the matte, and choosing one
  // switches the matte layer's video off.
  get setTrackMatte() {
    if (!features.setTrackMatte) return undefined;
    return (layer, type) => {
      editable(this.root);
      // setTrackMatte(null, any type) removes the matte and keeps the type;
      // a layer with NO_TRACK_MATTE is a documented no-op.
      if (!layer) {
        this._matte = null;
        this._matteType = type;
        return;
      }
      if (type === TRACK_MATTE.NO_TRACK_MATTE) return;
      if (layer === this) throw new Error("A layer can't be its own track matte");
      if (layer.comp !== this.comp) throw new Error('The track matte must be in the same comp');
      this._matte = layer;
      this._matteType = type;
      layer.enabled = false;
    };
  }
  get removeTrackMatte() {
    if (!features.setTrackMatte) return undefined;
    return () => { this._matte = null; };
  }
  get trackMatteLayer() { return this._matte || null; }
  get trackMatteType() { return this._matteType || TRACK_MATTE.NO_TRACK_MATTE; }
  get hasTrackMatte() { return !!this._matte; }
  get isTrackMatte() { return this.comp._layers.some((l) => l._matte === this); }
}
// Like After Effects, a text layer that was never renamed is named after
// its text, and its name changes whenever the text does.
class TextLayer extends AVLayer {
  constructor(comp, o) {
    super(comp, o);
    this.sourceText = o.text !== undefined ? o.text : (o.name || '');
    // Times of Source Text keyframes (pair with a rect function of time).
    this.textKeys = o.textKeys || [];
    this.textState = this.root.add(group('Text', 'ADBE Text Properties', [group('Animators', 'ADBE Text Animators')]));
  }
  // Test helper: a text animator with one Range Selector; returns the
  // selector's Start / End / Offset states. o.opacity: the animator sets
  // the selected characters' Opacity (0 hides them, like Typewriter).
  addAnimator(o = {}) {
    const animators = this.textState.children[0];
    const n = animators.children.length + 1;
    const start = prop('Start', 'ADBE Text Percent Start', 0);
    const end = prop('End', 'ADBE Text Percent End', 100);
    const offset = prop('Offset', 'ADBE Text Percent Offset', 0);
    // o.shape (1 Square, 2 Ramp Up, ...) / o.mode (1 Add, 2 Subtract, ...): the selector's Advanced settings.
    const sel = [start, end, offset];
    if (o.shape !== undefined || o.mode !== undefined) {
      sel.push(group('Advanced', 'ADBE Text Range Advanced', [
        prop('Units', 'ADBE Text Range Units', 1),
        prop('Mode', 'ADBE Text Selector Mode', o.mode || 1),
        prop('Amount', 'ADBE Text Selector Max Amount', 100),
        prop('Shape', 'ADBE Text Range Shape', o.shape || 1),
      ]));
    }
    animators.add(group(`Animator ${n}`, 'ADBE Text Animator', [
      group('Selectors', 'ADBE Text Selectors', [group('Range Selector 1', 'ADBE Text Selector', sel)]),
      group('Properties', 'ADBE Text Animator Properties',
        o.opacity === undefined ? [] : [prop('Opacity', 'ADBE Text Opacity', o.opacity)]),
    ]));
    return { start, end, offset };
  }
  get name() { return this.isNameSet ? this._name : String(this.sourceText).split(/[\r\n]/)[0]; }
  set name(v) {
    this._name = String(v);
    this.isNameSet = true;
  }
}
class CameraLayer extends Layer {
  constructor(comp, o) {
    super(comp, o);
    this.hasVideo = false;
  }
}

class ShapeLayer extends AVLayer {
  constructor(comp, o) {
    super(comp, o);
    this.contentsState = this.root.add(group('Contents', 'ADBE Root Vectors Group'));
  }
  rectShapes() {
    const out = [];
    const walk = (g) => g.children.forEach((c) => {
      if (c.matchName === 'ADBE Vector Shape - Rect') out.push(c);
      else if (c.group) walk(c);
    });
    walk(this.contentsState);
    return out;
  }
  sourceRectAtTime(t, ext) {
    const rects = this.rectShapes();
    if (!rects.length) return super.sourceRectAtTime(t, ext);
    let l = Infinity, tp = Infinity, r = -Infinity, b = -Infinity;
    rects.forEach((rs) => {
      const size = new Prop(rs.children[0]).valueAtTime(t, false);
      const pos = new Prop(rs.children[1]).valueAtTime(t, false);
      let grow = 0;
      if (ext) {
        rs.parent.children.forEach((c) => {
          if (c.matchName !== 'ADBE Vector Graphic - Stroke' && c.matchName !== 'ADBE Vector Graphic - G-Stroke') return;
          if (!c.enabled) return;
          const get = (mn) => new Prop(c.children.find((x) => x.matchName === mn)).valueAtTime(t, false);
          if (get('ADBE Vector Stroke Opacity') > 0) grow = Math.max(grow, get('ADBE Vector Stroke Width') / 2);
        });
      }
      l = Math.min(l, pos[0] - size[0] / 2 - grow);
      r = Math.max(r, pos[0] + size[0] / 2 + grow);
      tp = Math.min(tp, pos[1] - size[1] / 2 - grow);
      b = Math.max(b, pos[1] + size[1] / 2 + grow);
    });
    return { left: l, top: tp, width: r - l, height: b - tp };
  }
  boxRect(t = this.comp.time) {
    const rs = this.rectShapes()[0];
    if (!rs) throw new Error(`${this.name} has no rect`);
    const size = new Prop(rs.children[0]).valueAtTime(t, false);
    const pos = new Prop(rs.children[1]).valueAtTime(t, false);
    return { l: pos[0] - size[0] / 2, t: pos[1] - size[1] / 2, r: pos[0] + size[0] / 2, b: pos[1] + size[1] / 2,
      w: size[0], h: size[1], roundness: new Prop(rs.children[2]).valueAtTime(t, false) };
  }
  // Box rect corners in comp space (axis-aligned bounds).
  boxCompBounds(t = this.comp.time) {
    const r = this.boxRect(t);
    const pts = [[r.l, r.t], [r.r, r.t], [r.l, r.b], [r.r, r.b]].map((p) => this.toCompAt(t, p));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return { l: Math.min(...xs), t: Math.min(...ys), r: Math.max(...xs), b: Math.max(...ys) };
  }
}

class LayerCollection {
  constructor(comp) { this.comp = comp; }
  _add(layer) {
    this.comp._layers.unshift(layer);
    return layer;
  }
  addShape() {
    const c = this.comp;
    return this._add(new ShapeLayer(c, { name: 'Shape Layer 1', position: [c.width / 2, c.height / 2] }));
  }
  addText(name, o = {}) { return this._add(new TextLayer(this.comp, Object.assign({ name }, o))); }
  addShapeMember(name, o = {}) { return this._add(new ShapeLayer(this.comp, Object.assign({ name }, o))); }
  addSolid(name, o = {}) { return this._add(new AVLayer(this.comp, Object.assign({ name }, o))); }
  addNull(o = {}) { return this._add(new AVLayer(this.comp, Object.assign({ name: 'Null 1', nullLayer: true }, o))); }
  addCamera(name) { return this._add(new CameraLayer(this.comp, { name })); }
}

class CompItem {
  constructor(o = {}) {
    this.width = o.width || 1920;
    this.height = o.height || 1080;
    this.duration = o.duration || 10;
    this.frameDuration = 1 / (o.frameRate || 30);
    this.time = 0;
    this._layers = [];
    this.layers = new LayerCollection(this);
  }
  get numLayers() { return this._layers.length; }
  layer(k) {
    const l = typeof k === 'number' ? this._layers[k - 1] : this._layers.find((x) => x.name === k);
    if (!l) throw new Error(`No layer ${k}`);
    return l;
  }
  get selectedLayers() { return this._layers.filter((l) => l.selected); }
  select(...layers) {
    this._layers.forEach((l) => { l.selected = false; });
    layers.forEach((l) => { l.selected = true; });
  }
}

// ---------------------------------------------------------------------------
// ScriptUI
// ---------------------------------------------------------------------------
const graphicsStub = {
  BrushType: { SOLID_COLOR: 0 },
  PenType: { SOLID_COLOR: 0 },
  newBrush: () => ({}),
  newPen: () => ({}),
  rectPath() {},
  fillPath() {},
  strokePath() {},
};

class UIControl {
  constructor(type, text, items) {
    this.type = type;
    this.text = text || '';
    this.children = [];
    this.graphics = graphicsStub;
    this.size = [100, 20];
    this.preferredSize = { width: -1, height: -1 };
    this.items = (items || []).map((t, index) => ({ text: t, index }));
    this._selection = null;
    this.value = false;
  }
  add(type, bounds, a) {
    const c = Array.isArray(a) ? new UIControl(type, '', a) : new UIControl(type, a);
    this.children.push(c);
    return c;
  }
  get selection() { return this._selection; }
  set selection(i) { this._selection = typeof i === 'number' ? this.items[i] : i; }
  hide() {}
  show() {}
  find(pred) {
    if (pred(this)) return this;
    for (const c of this.children) {
      const f = c.find(pred);
      if (f) return f;
    }
    return null;
  }
}

class Panel extends UIControl {
  constructor() {
    super('panel');
    this.layout = { layout() {}, resize() {} };
  }
}

class Window extends Panel {
  center() {}
  show() {}
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------
function createHost() {
  const settings = new Map();
  const host = {
    alerts: [],
    confirms: [],
    confirmAnswer: true,
    undoDepth: 0,
    undoGroups: [],
    app: {
      project: { activeItem: null },
      settings: {
        haveSetting: (s, k) => settings.has(`${s}/${k}`),
        getSetting: (s, k) => settings.get(`${s}/${k}`),
        saveSetting: (s, k, v) => { settings.set(`${s}/${k}`, String(v)); },
      },
      beginUndoGroup(name) { host.undoDepth++; host.undoGroups.push(name); },
      endUndoGroup() { host.undoDepth--; },
    },
  };
  const globals = {
    app: host.app,
    alert: (msg) => { host.alerts.push(String(msg)); },
    confirm: (msg) => { host.confirms.push(String(msg)); return host.confirmAnswer; },
    $: { colorPicker: () => 0x336699 },
    CompItem, AVLayer, TextLayer, ShapeLayer, CameraLayer, Panel, Window,
    KeyframeInterpolationType: { LINEAR: KEY_LINEAR, BEZIER: 6613, HOLD: KEY_HOLD },
    TrackMatteType: TRACK_MATTE,
  };
  // AutoBox.jsx is plain ES3 and runs in this realm so `instanceof Array`
  // behaves like it does in ExtendScript.
  Object.assign(globalThis, globals);
  globalThis.AUTOBOX_TEST = {};
  vm.runInThisContext(fs.readFileSync(SCRIPT_PATH, 'utf8'), { filename: SCRIPT_PATH });
  host.api = globalThis.AUTOBOX_TEST.api;
  host.newComp = (o) => {
    const comp = new CompItem(o);
    host.app.project.activeItem = comp;
    return comp;
  };
  return host;
}

module.exports = { createHost, CompItem, ShapeLayer, TextLayer, Prop, SCRIPT_PATH, UIControl, features, TRACK_MATTE };
