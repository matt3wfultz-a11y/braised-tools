/*
 * AutoBox.jsx — Braised Tools
 *
 * Auto-sizing background boxes for Adobe After Effects 2020 (17.0.1) or newer.
 * The box wraps the layers parented to it with padding and rounded corners,
 * and animates to fit the layers coming in, borrowing their keyframe curves,
 * so it can be their track matte. Works with both the JavaScript and the
 * Legacy ExtendScript expression engines.
 *
 * Install
 *   Install dist/AutoBox.zxp with ZXP Installer (Window > Extensions > AutoBox),
 *   or copy this file into After Effects' "Scripts/ScriptUI Panels" folder,
 *   restart After Effects, then open Window > AutoBox.jsx.
 *
 * Use
 *   1. Select the layers you want boxed (text, shapes, footage, precomps).
 *   2. Set padding, corner radius, fill and stroke, then click "Create Box".
 *   3. Animate the layers as usual. Style the box in its Contents; its layout
 *      and animation settings are in its Effect Controls.
 */

(function AutoBoxPanel(thisObj) {
    var SCRIPT_NAME = "AutoBox";
    var VERSION = "3.0.0";
    var SETTINGS_SECTION = "BraisedAutoBox";
    var RIG_GROUP = "AutoBox";
    var RECT_NAME = "Box Rect";
    var EXPR_TAG = "// AutoBox";
    var PAINT_TAG = EXPR_TAG + " paint";
    // The per-layer override menu (an effect on a boxed layer).
    var IN_BOX = "In Box";
    // AutoBox 2.x drew the stroke on a layer of its own, with this group.
    var OLD_STROKE_GROUP = "AutoBox Stroke";

    var ANCHORS = ["Top Left", "Top", "Top Right", "Left", "Center", "Right", "Bottom Left", "Bottom", "Bottom Right"];
    var EASES = ["Linear", "Ease In", "Ease Out", "Ease In Out"];
    var GROW_FROM = ["Motion", "Box Anchor", "Snap"];
    var WHEN_EMPTY = ["Hold", "Collapse"];
    // The In Box menu on a layer: Auto (AutoBox decides), In, Out, or Skip
    // (doesn't count itself, but the layers parented to it do).
    var IN_BOX_ITEMS = ["Auto", "In", "Out", "Skip"];
    var PAINT_TYPES = ["Solid", "Linear Gradient", "Radial Gradient"];

    // Effect Controls added to every box layer, in order. ENGINE reads them by
    // name. A control without a key isn't a panel setting: it starts at
    // `initial` and Apply to Box leaves it alone.
    var CONTROLS = [
        { key: "padding", name: "Padding", type: "slider" },
        { key: "extraTop", name: "Extra Top", type: "slider" },
        { key: "extraRight", name: "Extra Right", type: "slider" },
        { key: "extraBottom", name: "Extra Bottom", type: "slider" },
        { key: "extraLeft", name: "Extra Left", type: "slider" },
        { key: "minWidth", name: "Min Width", type: "slider" },
        { key: "minHeight", name: "Min Height", type: "slider" },
        { key: "anchor", name: "Box Anchor", type: "dropdown", items: ANCHORS },
        { key: "ignoreHidden", name: "Ignore Hidden", type: "checkbox" },
        { key: "smartAnimate", name: "Smart Animate", type: "checkbox" },
        { key: "growFrom", name: "Grow From", type: "dropdown", items: GROW_FROM },
        { key: "whenEmpty", name: "When Empty", type: "dropdown", items: WHEN_EMPTY },
        { key: "morphTime", name: "Morph Time", type: "slider" },
        { key: "morphEase", name: "Morph Ease", type: "dropdown", items: EASES },
        { name: "Freeze", type: "checkbox", initial: 0 }
    ];

    // Controls of AutoBox 1.x / 2.x that 3.0 doesn't use. Converting a box
    // reads its look from them, then removes them.
    var OLD_CONTROLS = ["Layout", "Gap", "Align", "Justify", "Corner Radius", "Fill Type", "Fill Color", "Fill Color 2",
        "Fill Angle", "Fill Opacity", "Stroke Width", "Stroke Type", "Stroke Color", "Stroke Color 2", "Stroke Angle", "Stroke Opacity"];

    var CONTROL_MATCH = {
        slider: "ADBE Slider Control",
        color: "ADBE Color Control",
        checkbox: "ADBE Checkbox Control",
        angle: "ADBE Angle Control",
        dropdown: "ADBE Dropdown Control"
    };

    var DEFAULTS = {
        anchor: 1,
        padding: 32,
        extraTop: 0,
        extraRight: 0,
        extraBottom: 0,
        extraLeft: 0,
        radius: 16,
        minWidth: 0,
        minHeight: 0,
        ignoreHidden: 1,
        smartAnimate: 1,
        growFrom: 1,
        whenEmpty: 1,
        morphTime: 0.4,
        morphEase: 4,
        fillType: 1,
        fillColor: [27 / 255, 54 / 255, 67 / 255],
        fillAngle: 90,
        fillOpacity: 100,
        strokeType: 1,
        strokeColor: [0, 166 / 255, 105 / 255],
        strokeAngle: 90,
        strokeWidth: 0,
        strokeOpacity: 100
    };

    // ------------------------------------------------------------------
    // Expression engine
    //
    // A box's members are the layers parented to it (no layer names are
    // involved, so editing text, renaming or duplicating layers is safe).
    // Members never get expressions: their Position and everything else stay
    // native. Only the box's rect reads them.
    //
    // Smart Animate: the box doesn't follow its layers frame by frame. Each
    // layer's keyframes tell when it comes in, moves and leaves, and the box
    // morphs to fit the layers that are in, measured where they settle, on
    // the curve of the keyframes that brought them there. Layers leaving
    // don't shrink it: it holds until the next layer comes in. So the box can
    // be the track matte of the layers it holds.
    //
    // Written in ES3 so it runs on the Legacy ExtendScript engine as well as
    // the JavaScript engine.
    // ------------------------------------------------------------------
    var ENGINE = [
        'var AB_T = time;',
        'var AB_FD = thisComp.frameDuration;',
        'var AB_HALF = AB_FD / 2;',
        'function ab_ctl(n, d) { try { return AB_BOX.effect(n)(1).value; } catch (err) { return d; } }',
        'function ab_ctlAt(n, t, d) { try { return AB_BOX.effect(n)(1).valueAtTime(t); } catch (err) { return d; } }',
        'var AB_IN = AB_BOX.inPoint;',
        'var AB_OUT = AB_BOX.outPoint;',
        'var AB_ANCHOR = Math.min(8, Math.max(0, Math.round(ab_ctl("Box Anchor", 1)) - 1));',
        'var AB_PAD = ab_ctl("Padding", 0);',
        'var AB_PT = AB_PAD + ab_ctl("Extra Top", 0);',
        'var AB_PR = AB_PAD + ab_ctl("Extra Right", 0);',
        'var AB_PB = AB_PAD + ab_ctl("Extra Bottom", 0);',
        'var AB_PL = AB_PAD + ab_ctl("Extra Left", 0);',
        'var AB_MINW = ab_ctl("Min Width", 0);',
        'var AB_MINH = ab_ctl("Min Height", 0);',
        'var AB_SKIP = ab_ctl("Ignore Hidden", 1) > 0;',
        // Read where the box starts: switching it mid-shot would make the box jump.
        'var AB_SMART = ab_ctlAt("Smart Animate", AB_IN, 1) > 0;',
        'var AB_GROW = Math.round(ab_ctl("Grow From", 1));',
        'var AB_COLLAPSE = Math.round(ab_ctl("When Empty", 1)) == 2;',
        // Morph Time and Ease as they are when a morph starts.
        'function ab_mt(t) { return Math.max(0, ab_ctlAt("Morph Time", t, 0.4)); }',
        'var AB_EZ = {};',
        'function ab_ease(f, t) {',
        '  var e = AB_EZ[t];',
        '  if (e === undefined) e = AB_EZ[t] = Math.round(ab_ctlAt("Morph Ease", t, 4));',
        '  f = Math.max(0, Math.min(1, f));',
        '  if (e == 2) return f * f * f;',
        '  if (e == 3) return 1 - (1 - f) * (1 - f) * (1 - f);',
        '  if (e == 4) return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;',
        '  return f;',
        '}',
        // ---- members
        'function ab_isText(L) { try { return L.text.sourceText !== undefined; } catch (err) { return false; } }',
        // A live box (a released one keeps its shape but loses its controls).
        'function ab_isBox(L) { try { L.content("AutoBox"); L.effect("Padding"); return true; } catch (err) { return false; } }',
        // An AutoBox 2 stroke layer: drawn by its own box, never content.
        'function ab_isOldStroke(L) { try { L.content("AutoBox Stroke"); return true; } catch (err) { return false; } }',
        // The In Box menu: 1 Auto, 2 In, 3 Out, 4 Skip (doesn't count, its layers do).
        'function ab_ib(L) {',
        '  try { if (!L("ADBE Effect Parade").numProperties) return null; } catch (err) {}',
        '  try { return L.effect("In Box")(1); } catch (err2) { return null; }',
        '}',
        'function ab_mode(ib, t) { return ib ? Math.round(ib.valueAtTime(t)) : 1; }',
        'function ab_skips(L) {',
        '  var ib = ab_ib(L);',
        '  return !!ib && ib.numKeys == 0 && ab_mode(ib, AB_IN) == 4;',
        '}',
        // Set to Skip at any time: such a layer never decides when the layers
        // parented to it are in (its moves count as theirs).
        'function ab_skipsEver(L) {',
        '  var ib = ab_ib(L), i;',
        '  if (!ib) return false;',
        '  if (!ib.numKeys) return ab_mode(ib, AB_IN) == 4;',
        '  for (i = 1; i <= ib.numKeys; i++) if (Math.round(ib.key(i).value) == 4) return true;',
        '  return false;',
        '}',
        // Text animators that hide what they select (Opacity or Scale near 0, at
        // the start or at any of their keys): with these, how much of the text shows
        // can be read off their Range Selectors and how much they hide.
        'function ab_hiders(L) {',
        '  var out = [], i, j, k;',
        '  var low = function (P, scale) {',
        '    var v = [P.valueAtTime(AB_IN)];',
        '    for (k = 1; k <= P.numKeys; k++) v.push(P.key(k).value);',
        '    for (k = 0; k < v.length; k++) {',
        '      if (scale ? Math.abs(v[k][0]) < 1 || Math.abs(v[k][1]) < 1 : v[k] < 50) return true;',
        '    }',
        '    return false;',
        '  };',
        '  try {',
        '    var A = L("ADBE Text Properties")("ADBE Text Animators");',
        '    for (i = 1; i <= A.numProperties; i++) {',
        '      var P = A(i)("ADBE Text Animator Properties"), op = null, sc = null;',
        '      try { op = P("ADBE Text Opacity"); if (!low(op, false)) op = null; } catch (err) { op = null; }',
        '      try { sc = P("ADBE Text Scale 3D"); if (!low(sc, true)) sc = null; } catch (err2) { sc = null; }',
        '      if (!op && !sc) continue;',
        '      var S = A(i)("ADBE Text Selectors");',
        '      for (j = 1; j <= S.numProperties; j++) {',
        '        try { S(j)("ADBE Text Percent Start"); out.push({ S: S(j), op: op, sc: sc }); } catch (err3) {}',
        '      }',
        '    }',
        '  } catch (err4) {}',
        '  return out.length ? out : null;',
        '}',
        // How much of the text shows at t (0..1), going by its hiding animators.
        'function ab_textVis(m, t) {',
        '  var hidden = 0, i;',
        '  for (i = 0; i < m.hide.length; i++) {',
        '    var H = m.hide[i], S = H.S, f = 0, how = 0;',
        // How much its animator hides what it selects, now.
        '    try { if (H.op) how = Math.max(how, 1 - Math.max(0, Math.min(100, H.op.valueAtTime(t))) / 100); } catch (err4) {}',
        '    try {',
        '      if (H.sc) {',
        '        var sv = H.sc.valueAtTime(t);',
        '        how = Math.max(how, 1 - Math.max(0, Math.min(100, Math.min(Math.abs(sv[0]), Math.abs(sv[1])))) / 100);',
        '      }',
        '    } catch (err5) {}',
        '    try {',
        '      var adv = null, units = 1, amt = 100;',
        '      try { adv = S("ADBE Text Range Advanced"); units = Math.round(adv("ADBE Text Range Units").valueAtTime(t)); } catch (err) {}',
        '      try { amt = adv("ADBE Text Selector Max Amount").valueAtTime(t); } catch (err2) {}',
        '      if (units == 2) {',
        '        var len = Math.max(1, String(m.L.text.sourceText.valueAtTime(t)).length);',
        '        var io = S("ADBE Text Index Offset").valueAtTime(t);',
        '        var ia = Math.max(0, Math.min(len, S("ADBE Text Index Start").valueAtTime(t) + io));',
        '        var ib = Math.max(0, Math.min(len, S("ADBE Text Index End").valueAtTime(t) + io));',
        '        f = Math.abs(ib - ia) / len;',
        '      } else {',
        '        var o = S("ADBE Text Percent Offset").valueAtTime(t);',
        '        var a = Math.max(0, Math.min(100, S("ADBE Text Percent Start").valueAtTime(t) + o));',
        '        var b = Math.max(0, Math.min(100, S("ADBE Text Percent End").valueAtTime(t) + o));',
        '        f = Math.abs(b - a) / 100;',
        '      }',
        '      f *= Math.max(0, Math.min(100, amt)) / 100 * how;',
        '    } catch (err3) { f = 0; }',
        '    hidden = Math.max(hidden, f);',
        '  }',
        '  return 1 - hidden;',
        '}',
        // L and its parents below the box. A box nested in this one doesn't hide its
        // layers: they count here too, grown by its padding (see ab_geom).
        'function ab_path(L) {',
        '  var chain = [L], cur = L;',
        '  for (var g = 0; g < 50 && cur.hasParent; g++) {',
        '    var p = cur.parent;',
        '    if (p.index == AB_BOX.index) return chain;',
        '    chain.push(p);',
        '    cur = p;',
        '  }',
        '  return null;',
        '}',
        'function ab_members() {',
        '  var out = [], n = thisComp.numLayers, bi = AB_BOX.index, i, j;',
        '  for (i = 1; i <= n; i++) {',
        '    if (i == bi) continue;',
        '    try {',
        '      var L = thisComp.layer(i);',
        '      if (!L.hasParent || L.hasVideo !== true) continue;',
        '      if (AB_SKIP && !L.enabled) continue;',
        '      var chain = ab_path(L);',
        '      if (!chain || ab_isBox(L) || ab_isOldStroke(L) || ab_skips(L)) continue;',
        '      var a = L.inPoint, b = L.outPoint, text = ab_isText(L);',
        // in/out: a time-reversed layer has its in point after its out point.
        '      var m = { L: L, i: i, chain: chain, text: text, lin: Math.min(a, b), lout: Math.max(a, b),',
        '        nest: [], up: -1, cache: {}, tm: {}, ib: ab_ib(L), hide: text ? ab_hiders(L) : null, own: [] };',
        // Nested boxes on the way up, and the nearest parent that is itself a
        // member (its moves come with it: see ab_timeline).
        '      for (j = 1; j < chain.length; j++) {',
        '        if (ab_isBox(chain[j])) m.nest.push(j);',
        '        else if (m.up < 0 && !ab_skipsEver(chain[j])) m.up = chain[j].index;',
        '      }',
        // A camera or light on the way up has no size to measure: leave it out.
        '      for (j = 0; j < chain.length; j++) ab_xf(m, j, AB_IN);',
        '      L.sourceRectAtTime(0, false);',
        '      out.push(m);',
        '    } catch (err) {}',
        '  }',
        '  return out;',
        '}',
        // ---- geometry
        // The transform of chain layer j at time T (cached).
        'function ab_xf(m, j, T) {',
        '  var key = j + "@" + T;',
        '  if (m.tm[key]) return m.tm[key];',
        '  var tr = m.chain[j].transform, r = tr.rotation.valueAtTime(T) * Math.PI / 180;',
        '  var q = { a: tr.anchorPoint.valueAtTime(T), s: tr.scale.valueAtTime(T), p: tr.position.valueAtTime(T), c: Math.cos(r), sn: Math.sin(r) };',
        '  m.tm[key] = q;',
        '  return q;',
        '}',
        'function ab_map(q, x, y) {',
        '  var dx = (x - q.a[0]) * q.s[0] / 100, dy = (y - q.a[1]) * q.s[1] / 100;',
        '  return [q.p[0] + dx * q.c - dy * q.sn, q.p[1] + dx * q.sn + dy * q.c];',
        '}',
        // sourceRectAtTime reads its time as the layer's own time: convert.
        'function ab_rect(m, t) {',
        '  var lt = t;',
        '  try { lt = m.L.sourceTime(t); } catch (err) { lt = t - m.L.startTime; }',
        '  return m.L.sourceRectAtTime(lt, !m.text);',
        '}',
        // What a nested box adds around its layers: padding, and half its stroke.
        'function ab_nestPad(B, T) {',
        '  var c = function (n) { try { return B.effect(n)(1).valueAtTime(T); } catch (err) { return 0; } };',
        '  var w = 0, names = ["Stroke", "Gradient Stroke"];',
        '  for (var i = 0; i < names.length; i++) {',
        '    try { w = Math.max(w, B.content("AutoBox").content(names[i])("ADBE Vector Stroke Width").valueAtTime(T)); } catch (err) {}',
        '  }',
        '  var p = c("Padding") + w / 2;',
        '  return [p + c("Extra Top"), p + c("Extra Right"), p + c("Extra Bottom"), p + c("Extra Left")];',
        '}',
        // A member's bounds in box space, placed where it is at time T. Inside a
        // nested box it's grown by that box's padding, so the outer box fits the
        // inner one without reading its (animated) rect.
        'function ab_geom(m, T) {',
        '  var key = "g" + T;',
        '  if (m.cache[key]) return m.cache[key];',
        '  var sr = ab_rect(m, T);',
        '  var x = [sr.left, sr.left + sr.width, sr.left, sr.left + sr.width];',
        '  var y = [sr.top, sr.top, sr.top + sr.height, sr.top + sr.height];',
        '  var g = null, n = 0, j, k;',
        '  for (j = 0; j < m.chain.length; j++) {',
        '    var q = ab_xf(m, j, T);',
        '    for (k = 0; k < 4; k++) {',
        '      var p = ab_map(q, x[k], y[k]);',
        '      x[k] = p[0]; y[k] = p[1];',
        '    }',
        '    if (n < m.nest.length && m.nest[n] == j + 1) {',
        '      var pad = ab_nestPad(m.chain[j + 1], T);',
        '      var l = Math.min(x[0], x[1], x[2], x[3]) - pad[3], r = Math.max(x[0], x[1], x[2], x[3]) + pad[1];',
        '      var t = Math.min(y[0], y[1], y[2], y[3]) - pad[0], b = Math.max(y[0], y[1], y[2], y[3]) + pad[2];',
        '      x = [l, r, l, r]; y = [t, t, b, b];',
        '      n++;',
        '    }',
        '  }',
        '  g = { l: Math.min(x[0], x[1], x[2], x[3]), t: Math.min(y[0], y[1], y[2], y[3]), r: Math.max(x[0], x[1], x[2], x[3]), b: Math.max(y[0], y[1], y[2], y[3]) };',
        '  m.cache[key] = g;',
        '  return g;',
        '}',
        'function ab_area(g) { return Math.max(0, g.r - g.l) * Math.max(0, g.b - g.t); }',
        'function ab_overlap(a, b) {',
        '  return Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l)) * Math.max(0, Math.min(a.b, b.b) - Math.max(a.t, b.t));',
        '}',
        'function ab_padded(g) { return { l: g.l - AB_PL, t: g.t - AB_PT, r: g.r + AB_PR, b: g.b + AB_PB }; }',
        // Clear of each other (a little overlap allowed).
        'function ab_apart(a, b) { return ab_overlap(a, b) <= 0.05 * Math.min(ab_area(a), ab_area(b)) + 1e-9; }',
        // Shown at time t: within its in/out points, opaque enough, not scaled away.
        'function ab_present(m, t) {',
        '  if (t < m.lin - AB_HALF || t >= m.lout) return false;',
        '  return ab_shown(m, t);',
        '}',
        // Opaque enough and not scaled away at t (a move's end is read just inside
        // the layer's life, so ending at its out point isn't hiding it).
        'function ab_shownAt(m, t) { return ab_shown(m, Math.max(m.lin, Math.min(t, m.lout - AB_FD))); }',
        'function ab_shown(m, t) {',
        '  var key = "p" + t;',
        '  if (m.cache[key] !== undefined) return m.cache[key];',
        '  var on = true;',
        '  try { on = m.L.transform.opacity.valueAtTime(t) > 1; } catch (err) {}',
        '  if (on && m.hide) on = ab_textVis(m, t) > 0.01;',
        '  for (var j = 0; on && j < m.chain.length; j++) {',
        '    var s = ab_xf(m, j, t).s;',
        '    if (Math.abs(s[0]) < 0.5 || Math.abs(s[1]) < 0.5) on = false;',
        '  }',
        '  m.cache[key] = on;',
        '  return on;',
        '}',
        // ---- moves: what a member's keyframes do
        'function ab_d2(a, b) {',
        '  if (typeof a == "number") return (a - b) * (a - b);',
        '  var d = 0;',
        '  for (var i = 0; i < a.length; i++) d += (a[i] - b[i]) * (a[i] - b[i]);',
        '  return d;',
        '}',
        // Changing keyframe segments of P. A hold key's jump is instantaneous.
        // kind: 0 position/anchor (px), 1 scale (%), 2 rotation, 3 opacity, 4 text reveal.
        'function ab_segs(P, kind, out) {',
        '  var n = P.numKeys;',
        '  if (n < 2) return;',
        '  var ta = P.key(1).time, va = P.valueAtTime(ta);',
        '  for (var i = 2; i <= n; i++) {',
        '    var tb = P.key(i).time, vb = P.valueAtTime(tb);',
        '    if (ab_d2(va, vb) > 1e-6) {',
        '      var late = P.valueAtTime(Math.max(ta, tb - AB_HALF)), mid = P.valueAtTime((ta + tb) / 2);',
        '      if (ab_d2(mid, va) < 1e-6 && ab_d2(late, va) < 1e-6) out.push({ s: tb, e: tb, P: null, kind: kind });',
        '      else out.push({ s: ta, e: tb, P: P, kind: kind, a: va, b: vb });',
        '    }',
        '    ta = tb;',
        '    va = vb;',
        '  }',
        '}',
        // The member's own moves: its transform, opacity and text, and those of any
        // nested box or skipped layer between it and the next member up.
        'function ab_moves(m) {',
        '  var segs = [], j, i;',
        '  for (j = 0; j < m.chain.length; j++) {',
        '    var X = m.chain[j];',
        '    if (j > 0 && X.index == m.up) break;',
        '    var tr = X.transform;',
        '    var props = [[tr.position, 0], [tr.scale, 1], [tr.rotation, 2], [tr.anchorPoint, 0]];',
        '    if (!tr.position.numKeys) {',
        '      try { props.push([tr.xPosition, 0], [tr.yPosition, 0]); } catch (err) {}',
        '    }',
        '    for (i = 0; i < props.length; i++) {',
        '      try {',
        // Tracking data or baked wiggle: too many keys to read as moves.
        '        if (props[i][0].numKeys > 24) m.dense = true;',
        '        else ab_segs(props[i][0], props[i][1], segs);',
        '      } catch (err2) {}',
        '    }',
        '  }',
        '  try { ab_segs(m.L.transform.opacity, 3, segs); } catch (err3) {}',
        '  if (m.text) {',
        '    try {',
        '      var st = m.L.text.sourceText;',
        '      for (i = 2; i <= st.numKeys; i++) segs.push({ s: st.key(i).time, e: st.key(i).time, P: null, kind: 5 });',
        '    } catch (err4) {}',
        // Text animators: their Range Selectors' Start / End / Offset.
        '    try {',
        '      var A = m.L("ADBE Text Properties")("ADBE Text Animators");',
        '      for (i = 1; i <= A.numProperties; i++) {',
        '        var S = A(i)("ADBE Text Selectors");',
        '        for (j = 1; j <= S.numProperties; j++) {',
        '          var names = ["ADBE Text Percent Start", "ADBE Text Percent End", "ADBE Text Percent Offset",',
        '            "ADBE Text Index Start", "ADBE Text Index End", "ADBE Text Index Offset", "ADBE Text Selector Max Amount"];',
        '          for (var n = 0; n < names.length; n++) {',
        '            try { ab_segs(S(j)(names[n]), 4, segs); } catch (err5) {}',
        '          }',
        '          try { ab_segs(S(j)("ADBE Text Range Advanced")("ADBE Text Selector Max Amount"), 4, segs); } catch (err7) {}',
        '        }',
        // An animator's own Opacity or Scale keyed: a reveal too.
        '        try { ab_segs(A(i)("ADBE Text Animator Properties")("ADBE Text Opacity"), 4, segs); } catch (err8) {}',
        '        try { ab_segs(A(i)("ADBE Text Animator Properties")("ADBE Text Scale 3D"), 4, segs); } catch (err9) {}',
        '      }',
        '    } catch (err6) {}',
        '  }',
        '  for (i = 0; i < segs.length; i++) segs[i].n = i;',
        '  segs.sort(function (x, y) { return x.s - y.s || x.e - y.e || x.kind - y.kind || x.n - y.n; });',
        // Segments that start together and end about together are one move (X and
        // Y, or a slide with a fade). Back-to-back segments stay separate moves.
        '  var moves = [];',
        '  for (i = 0; i < segs.length; i++) {',
        '    var g = segs[i], mv = null;',
        '    for (j = moves.length - 1; j >= 0 && !mv; j--) {',
        '      var c = moves[j], shorter = Math.min(c.e - c.s, g.e - g.s);',
        '      if (Math.abs(c.s - g.s) <= AB_HALF && Math.abs(c.e - g.e) <= Math.max(0.25, shorter / 2)) mv = c;',
        '    }',
        '    if (!mv) {',
        '      mv = { s: g.s, e: g.e, segs: [] };',
        '      moves.push(mv);',
        '    }',
        '    mv.segs.push(g);',
        '    if (g.e > mv.e) mv.e = g.e;',
        '  }',
        '  for (i = 0; i < moves.length; i++) {',
        // s0: when to look at where it was (just before a jump).
        '    moves[i].s0 = moves[i].e - moves[i].s < AB_HALF ? moves[i].s - AB_HALF : moves[i].s;',
        '    ab_driver(m, moves[i]);',
        '  }',
        '  for (i = 0; i < moves.length; i++) moves[i].n = i;',
        '  moves.sort(function (x, y) { return x.s - y.s || x.e - y.e || x.n - y.n; });',
        '  return moves;',
        '}',
        // The curve the box borrows: the segment with the biggest effect on the
        // member's size or place (a fade or a text reveal only if nothing moves).
        'function ab_driver(m, mv) {',
        '  mv.d = null;',
        '  mv.txt = true;',
        '  mv.reveal = false;',
        '  var best = 0, g = ab_geom(m, mv.e), size = Math.max(1, ((g.r - g.l) + (g.b - g.t)) / 2);',
        '  for (var i = 0; i < mv.segs.length; i++) {',
        '    var sg = mv.segs[i];',
        '    if (sg.kind != 5) mv.txt = false;',
        '    if (sg.kind == 4) mv.reveal = true;',
        '    if (!sg.P) continue;',
        '    var d = Math.sqrt(ab_d2(sg.a, sg.b)), w = 0;',
        '    if (sg.kind == 0) w = d;',
        '    else if (sg.kind == 1) w = d / 100 * size;',
        '    else if (sg.kind == 2) w = d * Math.PI / 180 * size;',
        '    else w = d * 1e-3;',
        '    if (d >= 1 && w > best) {',
        '      best = w;',
        '      mv.d = { P: sg.P, a: sg.a, b: sg.b };',
        '    }',
        '  }',
        '}',
        // How far along a curve is at t: the value projected onto the line from a to
        // b, so the box keeps the layer's easing, overshoot and bounce.
        'function ab_proj(d, t) {',
        '  var v = d.P.valueAtTime(t), p;',
        '  if (typeof v == "number") p = (v - d.a) / (d.b - d.a);',
        '  else {',
        '    var num = 0, den = 0;',
        '    for (var i = 0; i < v.length; i++) {',
        '      num += (v[i] - d.a[i]) * (d.b[i] - d.a[i]);',
        '      den += (d.b[i] - d.a[i]) * (d.b[i] - d.a[i]);',
        '    }',
        '    p = num / den;',
        '  }',
        '  return Math.max(-0.5, Math.min(1.5, p));',
        '}',
        // ---- when each member is in
        // A morph: over [s, e] on curve d (picked up at p0 when it starts mid-way),
        // or instantaneous (Morph Time around s), or a snap. T: when the member is
        // measured (-1: live).
        'var AB_SEQ = 0;',
        'function ab_ev(m, kind, s, mv, T) {',
        '  var ev = { m: m, kind: kind, s: s, e: s, d: null, p0: 0, T: T, snap: false, inst: true, seq: AB_SEQ++, mv: mv, mt: ab_mt(s) };',
        '  if (mv && mv.d && mv.e - s > AB_HALF) {',
        '    var p0 = s > mv.s + 1e-9 ? ab_proj(mv.d, s) : 0;',
        '    if (p0 < 0.95) {',
        '      ev.d = mv.d; ev.p0 = p0; ev.e = mv.e; ev.inst = false;',
        '    }',
        '  }',
        '  if (ev.inst && ev.mt <= 0) ev.snap = true;',
        '  return ev;',
        '}',
        // Picking a curve up mid-way: start at 0 without amplifying its overshoot.
        'function ab_renorm(p, p0) {',
        '  if (p < p0) return p - p0;',
        '  if (p <= 1) return (p - p0) / (1 - p0);',
        '  return p;',
        '}',
        // Is the member in before its first move? Out if it isn't shown, or it's
        // moving in as it appears; in if it never really goes anywhere, or its
        // first big move hides it. Otherwise that move is ambiguous (coming in, or
        // leaving?). Then, in turn: the reading where it always comes back to the
        // same spot; the pose where it was when the box was made; the pose nearer the
        // other layers; the one inside the frame; and last, a layer that sat still
        // for a second or more was already in. Moves over before its in point (a
        // trimmed head) don't count: it appears where they left it.
        'function ab_startsIn(m, mv, H) {',
        '  if (!ab_shownAt(m, m.lin)) return false;',
        '  var tr = [], i;',
        '  for (i = 0; i < mv.length; i++) if (mv[i].e > m.lin + AB_HALF && ab_trans(m, mv[i])) tr.push(mv[i]);',
        '  if (!tr.length) return true;',
        '  var first = tr[0], d;',
        // Moving as it appears: coming in, unless it moves off its own home.
        '  if (first.s <= m.lin + AB_HALF) return ab_leavesHome(m, ab_geom(m, first.s0), ab_geom(m, first.e));',
        '  if (!ab_shownAt(m, first.e)) return true;',
        // A reveal by an animator that doesn't hide what it selects: read as coming in.
        '  if (first.reveal && !m.hide) return false;',
        '  if (tr.length > 1) {',
        '    var poses = [ab_geom(m, first.s0)], a = true, b = true, j;',
        '    for (i = 0; i < tr.length; i++) poses.push(ab_geom(m, tr[i].e));',
        '    for (i = 0; i < poses.length; i++) {',
        '      for (j = i + 2; j < poses.length; j += 2) {',
        '        if (ab_apart(ab_padded(poses[i]), poses[j])) {',
        '          if (i % 2) b = false;',
        '          else a = false;',
        '        }',
        '      }',
        '    }',
        '    if (a && !b) return true;',
        '    if (b && !a) return false;',
        '  }',
        '  d = ab_moreIn(m, ab_geom(m, first.s0), ab_geom(m, first.e), H);',
        '  if (d) return d < 0;',
        '  return first.s - m.lin >= 1;',
        '}',
        // Is pose ge more in than pose gs (1), less in (-1), or can't tell (0)? By
        // where the layer was when the box was made, then nearness to the other
        // layers (H), then how much is inside the frame.
        'function ab_moreIn(m, gs, ge, H) {',
        '  var fs, fe;',
        '  if (AB_HOME) {',
        '    var own = ab_ownHome(m, gs, ge);',
        '    fs = ab_onHome(gs, own);',
        '    fe = ab_onHome(ge, own);',
        '    if (fe - fs > 0.25) return own && ab_swap(ge, gs, own) ? -1 : 1;',
        '    if (fs - fe > 0.25) return own && ab_swap(gs, ge, own) ? 1 : -1;',
        '  }',
        '  if (H) {',
        '    fs = ab_gap(gs, H);',
        '    fe = ab_gap(ge, H);',
        '    if (fs - fe > 5) return 1;',
        '    if (fe - fs > 5) return -1;',
        '  }',
        '  fs = ab_inFrame(gs);',
        '  fe = ab_inFrame(ge);',
        '  if (fe - fs > 0.25) return 1;',
        '  if (fs - fe > 0.25) return -1;',
        '  return 0;',
        '}',
        // The home written for this layer ([l, t, r, b, index, name]): the one with
        // its name (its index tells apart layers of the same name), else the only
        // one of its size (renamed, or a text layer whose text was edited). null:
        // go by all of them. An index alone means nothing: layers move in the stack.
        'function ab_ownHome(m, gs, ge) {',
        '  var named = [], same = [], i, nm = m.L.name;',
        '  var fits = function (h, g) {',
        '    var w = g.r - g.l, ht = g.b - g.t;',
        '    return Math.abs(h[2] - h[0] - w) <= 2 + 0.02 * w && Math.abs(h[3] - h[1] - ht) <= 2 + 0.02 * ht;',
        '  };',
        '  for (i = 0; i < AB_HOME.length; i++) if (AB_HOME[i].length > 5 && AB_HOME[i][5] === nm) named.push(AB_HOME[i]);',
        '  if (named.length == 1) return named[0];',
        '  for (i = 0; i < named.length; i++) if (named[i][4] == m.L.index) return named[i];',
        '  var list = named.length ? named : AB_HOME;',
        '  for (i = 0; i < list.length; i++) if (fits(list[i], gs) || fits(list[i], ge)) same.push(list[i]);',
        '  return same.length == 1 ? same[0] : null;',
        '}',
        // Moving as it appears, it was on screen on its own home when the box was
        // made and moves off it: it was in, and is going.
        'function ab_leavesHome(m, gs, ge) {',
        '  if (!AB_HOME) return false;',
        '  var own = ab_ownHome(m, gs, ge);',
        '  if (!own || ab_inFrame({ l: own[0], t: own[1], r: own[2], b: own[3] }) < 0.5) return false;',
        '  return ab_onHome(gs, own) >= 0.75 && ab_onHome(ge, own) <= 0.25 && !ab_swap(gs, ge, own);',
        '}',
        // The layer was at pose `was` when the box was made, but its other pose `to`
        // is right where another layer was then, and `was` isn't: a swap, so `to`
        // is the pose that's in (the box was made before or after the swap).
        'function ab_swap(was, to, own) {',
        '  var on = function (g) {',
        '    var best = 0;',
        '    for (var i = 0; i < AB_HOME.length; i++) {',
        '      var h = AB_HOME[i];',
        '      if (h === own) continue;',
        '      var r = { l: h[0], t: h[1], r: h[2], b: h[3] };',
        '      best = Math.max(best, ab_overlap(g, r) / Math.max(1e-9, Math.min(ab_area(g), ab_area(r))));',
        '    }',
        '    return best;',
        '  };',
        '  return on(to) >= 0.9 && on(was) < 0.9;',
        '}',
        // How much of a rect lies on its home (or, without one, where any of the
        // layers were when the box was made).
        'function ab_onHome(g, own) {',
        '  var o = 0, list = own ? [own] : AB_HOME;',
        '  for (var i = 0; i < list.length; i++) {',
        '    var h = list[i];',
        '    o += ab_overlap(g, { l: h[0], t: h[1], r: h[2], b: h[3] });',
        '  }',
        '  return Math.min(1, o / Math.max(1e-9, ab_area(g)));',
        '}',
        // Distance between two rects (0 when they touch or overlap).
        'function ab_gap(a, b) {',
        '  var dx = Math.max(0, a.l - b.r, b.l - a.r), dy = Math.max(0, a.t - b.b, b.t - a.b);',
        '  return Math.sqrt(dx * dx + dy * dy);',
        '}',
        // How much of a box-space rect is inside the comp frame.
        'function ab_inFrame(g) {',
        '  var xs = [], ys = [], k;',
        '  for (k = 0; k < 4; k++) {',
        '    var c = AB_BOX.toComp([k % 2 ? g.r : g.l, k < 2 ? g.t : g.b], AB_IN);',
        '    xs.push(c[0]); ys.push(c[1]);',
        '  }',
        '  var f = { l: Math.min(xs[0], xs[1], xs[2], xs[3]), t: Math.min(ys[0], ys[1], ys[2], ys[3]), r: Math.max(xs[0], xs[1], xs[2], xs[3]), b: Math.max(ys[0], ys[1], ys[2], ys[3]) };',
        '  return ab_overlap(f, { l: 0, t: 0, r: thisComp.width, b: thisComp.height }) / Math.max(1e-9, ab_area(f));',
        '}',
        // A move that takes the member somewhere else entirely (clear of where it
        // was, padding included), shows or hides it, or reveals its text.
        'function ab_trans(m, mv) {',
        '  if (mv.trans !== undefined) return mv.trans;',
        '  var ps = ab_shownAt(m, mv.s0), pe = ab_shownAt(m, mv.e);',
        '  mv.trans = ps != pe || mv.reveal || ab_apart(ab_padded(ab_geom(m, mv.s0)), ab_geom(m, mv.e));',
        '  return mv.trans;',
        '}',
        // Where a member sits once it's in: for the others' "is it in?" question.
        'function ab_home(m, mv) {',
        '  for (var i = 0; i < mv.length; i++) {',
        '    if (mv[i].e <= m.lin + AB_HALF || !ab_trans(m, mv[i])) continue;',
        '    if (mv[i].s <= m.lin + AB_HALF || !ab_shownAt(m, m.lin)) return ab_geom(m, mv[i].e);',
        '    break;',
        '  }',
        '  return ab_geom(m, m.lin);',
        '}',
        // Automatic: in/out intervals [{ a, enter, b, leave }] and repositions.
        // While a layer is in, a move that hides it, or clears where it was and
        // takes it less in, takes it out. A move under way while it comes in (a
        // fade shorter than its slide), or straight after (a second leg, an arc
        // through a middle key), is the rest of the way in unless it goes less in.
        // Its out point takes it out.
        'function ab_auto(m, mv, H) {',
        '  var tl = { segs: [], repos: [] }, cur = null, last = null, until = -1e9, rev = null, i;',
        '  var open = function (s, ev, T) {',
        '    cur = { a: s, enter: ev, b: 1e9, leave: null };',
        '    tl.segs.push(cur);',
        '    last = ab_geom(m, T);',
        '    until = ev.e;',
        '  };',
        '  if (ab_startsIn(m, mv, H)) open(m.lin, ab_ev(m, 0, m.lin, null, m.lin), m.lin);',
        '  for (i = 0; i < mv.length; i++) {',
        '    var v = mv[i];',
        '    if (v.e <= m.lin + AB_HALF || v.s >= m.lout) continue;',
        '    if (!cur) {',
        '      if (ab_trans(m, v) && ab_shownAt(m, v.e)) {',
        '        var s = Math.max(m.lin, v.s);',
        '        open(s, ab_ev(m, 0, s, v, v.e), v.e);',
        '        until = Math.max(until, v.e);',
        '        rev = v.reveal ? v.d : null;',
        '      }',
        '      continue;',
        '    }',
        '    var ge = ab_geom(m, v.e), dir = ab_moreIn(m, ab_geom(m, v.s0), ge, H);',
        '    var more = v.s < until - AB_HALF || (v.s <= until + AB_HALF ? dir >= 0 : dir > 0);',
        '    if (!ab_shownAt(m, v.e) || ab_unreveal(m, v, rev) || (!more && ab_apart(ab_padded(last), ge))) {',
        // (Leaving the moment it's in: still in for that moment.)
        '      cur.b = Math.max(v.s, cur.a + AB_HALF);',
        '      cur.leave = v;',
        '      cur = null;',
        '      rev = null;',
        '      continue;',
        '    }',
        '    if (more) until = Math.max(until, v.e);',
        '    if (v.d || v.e - v.s < AB_HALF || v.txt) {',
        '      tl.repos.push(ab_ev(m, 1, v.s, v, v.e));',
        '      last = ge;',
        '    }',
        '  }',
        '  if (cur && m.lout < AB_OUT - AB_HALF) cur.b = m.lout;',
        '  return tl;',
        '}',
        // Without animators that hide text (then whether it shows tells), a reveal
        // that runs back the way the layer's entrance revealed it takes it out.
        'function ab_unreveal(m, v, rev) {',
        '  if (!rev || m.hide || !v.reveal) return false;',
        '  for (var i = 0; i < v.segs.length; i++) {',
        '    var sg = v.segs[i];',
        '    if (sg.P === rev.P && (sg.b - sg.a) * (rev.b - rev.a) < 0) return true;',
        '  }',
        '  return false;',
        '}',
        // The In Box menu: In / Out / Skip where it says so, Auto elsewhere.
        'function ab_override(m, mv, auto) {',
        '  var ib = m.ib, cuts = [m.lin], i, j, k;',
        '  for (i = 1; i <= ib.numKeys; i++) cuts.push(ib.key(i).time);',
        '  for (i = 0; i < auto.segs.length; i++) cuts.push(auto.segs[i].a, auto.segs[i].b);',
        '  cuts.sort(function (x, y) { return x - y; });',
        '  var tl = { segs: [], repos: [] }, cur = null, prev = -1e9;',
        '  var inAt = function (t) {',
        '    var mode = ab_mode(ib, t);',
        '    return mode == 2 || (mode == 1 && ab_seg(auto, t) !== null);',
        '  };',
        '  for (i = 0; i < cuts.length; i++) {',
        '    var t = cuts[i];',
        '    if (t < m.lin || t >= m.lout || t - prev < 1e-9) continue;',
        '    prev = t;',
        '    var on = inAt(t);',
        '    if (on && !cur) {',
        '      var sg = ab_mode(ib, t) == 1 ? ab_seg(auto, t) : null;',
        '      var ev = sg && Math.abs(sg.a - t) < 1e-9 ? sg.enter : null;',
        '      if (!ev) {',
        '        var off = 1e9;',
        '        for (k = i + 1; k < cuts.length; k++) if (!inAt(cuts[k])) { off = cuts[k]; break; }',
        '        ev = ab_switchOn(m, mv, t, off);',
        '      }',
        '      cur = { a: t, enter: ev, b: 1e9, leave: null };',
        '      tl.segs.push(cur);',
        '    } else if (!on && cur) {',
        '      var ended = ab_mode(ib, t) == 1 ? ab_segEnding(auto, t) : null;',
        '      cur.b = t;',
        '      cur.leave = ended ? ended.leave : null;',
        '      cur = null;',
        '    }',
        '  }',
        '  if (cur && m.lout < AB_OUT - AB_HALF) cur.b = m.lout;',
        // Repositions: Auto's while in Auto, every move while In.
        '  for (i = 0; i < tl.segs.length; i++) {',
        '    var S = tl.segs[i];',
        '    for (j = 0; j < auto.repos.length; j++) {',
        '      var r = auto.repos[j];',
        '      if (r.s > S.a && r.s < S.b && ab_mode(ib, r.s) == 1) tl.repos.push(r);',
        '    }',
        '    for (j = 0; j < mv.length; j++) {',
        '      var v = mv[j];',
        '      if (v.s > S.a + AB_HALF && v.s < S.b && v !== S.enter.mv && ab_mode(ib, v.s) == 2 &&',
        '          (v.d || v.e - v.s < AB_HALF || v.txt)) tl.repos.push(ab_ev(m, 1, v.s, v, v.e));',
        '    }',
        '  }',
        '  return tl;',
        '}',
        'function ab_seg(tl, t) {',
        '  for (var i = 0; i < tl.segs.length; i++) if (tl.segs[i].a <= t + 1e-9 && t < tl.segs[i].b) return tl.segs[i];',
        '  return null;',
        '}',
        'function ab_segEnding(tl, t) {',
        '  for (var i = 0; i < tl.segs.length; i++) if (Math.abs(tl.segs[i].b - t) < 1e-9) return tl.segs[i];',
        '  return null;',
        '}',
        // Switched in at a: borrow a move that's under way or starts within Morph
        // Time; otherwise morph over Morph Time to where it next settles.
        'function ab_switchOn(m, mv, a, b) {',
        '  var mt = ab_mt(a), i, ev;',
        '  for (i = 0; i < mv.length; i++) {',
        '    var v = mv[i];',
        '    if (v.s <= a + mt && v.e > a + AB_HALF && v.s < b && v.d) return ab_ev(m, 0, Math.max(a, v.s), v, v.e);',
        '  }',
        '  var T = a;',
        '  for (i = 0; i < mv.length; i++) {',
        '    if (mv[i].s >= a && mv[i].s < b) {',
        '      T = mv[i].e;',
        '      break;',
        '    }',
        '  }',
        '  ev = ab_ev(m, 0, a, null, T);',
        '  if (a <= AB_IN + AB_HALF) ev.snap = true;',
        '  return ev;',
        '}',
        // Expressions, not keyframes, move it (wiggle, a counter, a rig, a wiggle on
        // top of keys): the box follows it frame by frame. Read by sampling its life
        // after its last key, the same on every frame.
        'function ab_live(m) {',
        '  var j, k, n, end = Math.min(m.lout, AB_OUT, thisComp.duration) - AB_HALF;',
        '  var last = function (P) { return P.numKeys ? P.key(P.numKeys).time : -1e9; };',
        '  var moves = function (get, t0) {',
        '    t0 = Math.max(m.lin, t0);',
        '    var v0 = get(t0);',
        '    for (n = 0; n < 2; n++) {',
        '      var t1 = t0 + (end - t0) * (n ? 0.93 : 0.41);',
        '      if (t1 > t0 + AB_HALF && ab_d2(v0, get(t1)) > 1e-6) return true;',
        '    }',
        '    return false;',
        '  };',
        '  for (j = 0; j < m.chain.length; j++) {',
        '    var tr = m.chain[j].transform, props = [tr.position, tr.scale, tr.rotation, tr.anchorPoint];',
        '    for (k = 0; k < props.length; k++) {',
        '      var P = props[k], t0 = last(P);',
        // Separated position: its keys are on X and Y.
        '      if (k == 0) {',
        '        try { t0 = Math.max(t0, last(tr.xPosition), last(tr.yPosition)); } catch (err) {}',
        '      }',
        '      if (moves(function (t) { return P.valueAtTime(t); }, t0)) return true;',
        '    }',
        '  }',
        '  if (m.text) {',
        '    var st = -1e9;',
        '    try { st = last(m.L.text.sourceText); } catch (err2) {}',
        '    var rectAt = function (t) { var r = ab_rect(m, t); return [r.left, r.top, r.width, r.height]; };',
        '    if (moves(rectAt, st)) return true;',
        '  }',
        '  return false;',
        '}',
        // Each member's final timeline. A member parented to another member is in
        // only while that one is, and moves with it.
        'function ab_timelines(members) {',
        '  var byIndex = {}, homes = [], i, j;',
        '  for (i = 0; i < members.length; i++) {',
        '    var m = members[i];',
        '    byIndex[m.i] = m;',
        '    m.mv = ab_moves(m);',
        '    m.live = m.dense || ab_live(m);',
        '    homes.push(ab_home(m, m.mv));',
        '  }',
        '  for (i = 0; i < members.length; i++) {',
        '    var H = null;',
        '    for (j = 0; j < members.length; j++) {',
        '      if (j == i || members[j].up == members[i].i) continue;',
        '      var h = homes[j];',
        '      H = H ? { l: Math.min(H.l, h.l), t: Math.min(H.t, h.t), r: Math.max(H.r, h.r), b: Math.max(H.b, h.b) } : h;',
        '    }',
        '    members[i].H = H;',
        '  }',
        '  var done = {};',
        '  var get = function (m) {',
        '    if (done[m.i]) return done[m.i];',
        '    done[m.i] = { segs: [], repos: [] };',
        '    var tl;',
        '    if (m.live) {',
        '      tl = { segs: [{ a: m.lin, enter: ab_ev(m, 0, m.lin, null, -1), b: m.lout < AB_OUT - AB_HALF ? m.lout : 1e9, leave: null }], repos: [] };',
        '      if (m.lin <= AB_IN + AB_HALF) tl.segs[0].enter.snap = true;',
        '    } else {',
        '      var auto = ab_auto(m, m.mv, m.H);',
        '      if (m.lin <= AB_IN + AB_HALF && auto.segs.length && auto.segs[0].a <= m.lin && !auto.segs[0].enter.d) auto.segs[0].enter.snap = true;',
        '      tl = m.ib ? ab_override(m, m.mv, auto) : auto;',
        '      tl = ab_jitter(m, tl);',
        '    }',
        '    var up = byIndex[m.up];',
        '    if (up) tl = ab_gate(m, tl, get(up));',
        '    done[m.i] = tl;',
        '    return tl;',
        '  };',
        '  for (i = 0; i < members.length; i++) members[i].tl = get(members[i]);',
        '}',
        // Many little moves (wiggler keys) don't reshape the box: it holds a shape
        // that covers every one of them. Source Text changes still reshape it.
        'function ab_jitter(m, tl) {',
        '  var moved = function (r, sg) { return r.s >= sg.a && r.s < sg.b && !(r.mv && r.mv.txt); };',
        '  for (var i = 0; i < tl.segs.length; i++) {',
        '    var sg = tl.segs[i], Ts = [sg.enter.T], j;',
        '    for (j = 0; j < tl.repos.length; j++) if (moved(tl.repos[j], sg)) Ts.push(tl.repos[j].T);',
        '    if (Ts.length <= 9) continue;',
        '    sg.enter.Ts = Ts;',
        '    var keep = [];',
        '    for (j = 0; j < tl.repos.length; j++) if (!moved(tl.repos[j], sg)) keep.push(tl.repos[j]);',
        '    tl.repos = keep;',
        '  }',
        '  return tl;',
        '}',
        // In only while its parent member is; it comes in, moves and leaves with it.
        'function ab_gate(m, own, up) {',
        '  var out = { segs: [], repos: [] }, i, j;',
        '  for (i = 0; i < own.segs.length; i++) {',
        '    for (j = 0; j < up.segs.length; j++) {',
        '      var A = own.segs[i], B = up.segs[j], a = Math.max(A.a, B.a), b = Math.min(A.b, B.b);',
        '      if (a >= b) continue;',
        '      var src = A.a >= B.a ? A.enter : B.enter, ev = src;',
        '      if (src.m !== m) {',
        '        ev = ab_ev(m, 0, src.s, null, src.T);',
        '        ev.d = src.d; ev.p0 = src.p0; ev.e = src.e; ev.inst = src.inst; ev.snap = src.snap; ev.mv = src.mv;',
        '      }',
        '      out.segs.push({ a: a, enter: ev, b: b, leave: A.b <= B.b ? A.leave : B.leave });',
        '    }',
        '  }',
        '  var add = function (list) {',
        '    for (var k = 0; k < list.length; k++) {',
        '      var r = list[k];',
        '      for (var n = 0; n < out.segs.length; n++) {',
        '        if (r.s >= out.segs[n].a && r.s < out.segs[n].b) {',
        '          var ev = r;',
        '          if (r.m !== m) {',
        '            ev = ab_ev(m, 1, r.s, null, r.T);',
        '            ev.d = r.d; ev.p0 = r.p0; ev.e = r.e; ev.inst = r.inst; ev.snap = r.snap; ev.mv = r.mv;',
        '          }',
        '          out.repos.push(ev);',
        '          break;',
        '        }',
        '      }',
        '    }',
        '  };',
        '  add(own.repos);',
        '  add(up.repos);',
        '  return out;',
        '}',
        // ---- the box over time
        'function ab_grow(lo, hi, min, a) {',
        '  var d = min - (hi - lo);',
        '  if (d <= 0) return [lo, hi];',
        '  if (a == 0) return [lo, hi + d];',
        '  if (a == 1) return [lo - d / 2, hi + d / 2];',
        '  return [lo - d, hi];',
        '}',
        'function ab_pad(u) {',
        '  if (!u || u.l > u.r) return null;',
        '  var ax = AB_ANCHOR % 3, ay = Math.floor(AB_ANCHOR / 3);',
        '  var gx = ab_grow(u.l - AB_PL, u.r + AB_PR, AB_MINW, ax), gy = ab_grow(u.t - AB_PT, u.b + AB_PB, AB_MINH, ay);',
        '  return { l: gx[0], t: gy[0], r: gx[1], b: gy[1] };',
        '}',
        // The box around the members in `set` ([member, T] pairs) at time `now`.
        'function ab_fit(set, now) {',
        '  var u = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity }, i, k;',
        '  for (i = 0; i < set.length; i++) {',
        '    var m = set[i][0], Ts = set[i][2] || [set[i][1]];',
        '    for (k = 0; k < Ts.length; k++) {',
        '      var g = ab_geom(m, Ts[k] < 0 ? now : Ts[k]);',
        '      if (g.r - g.l < 0.01 && g.b - g.t < 0.01) continue;',
        '      u.l = Math.min(u.l, g.l); u.t = Math.min(u.t, g.t); u.r = Math.max(u.r, g.r); u.b = Math.max(u.b, g.b);',
        '    }',
        '  }',
        '  return ab_pad(u);',
        '}',
        'function ab_point(x, y) { return { l: x, t: y, r: x, b: y }; }',
        'function ab_anchorPt(r) {',
        '  var ax = AB_ANCHOR % 3, ay = Math.floor(AB_ANCHOR / 3);',
        '  return ab_point(r.l + (r.r - r.l) * ax / 2, r.t + (r.b - r.t) * ay / 2);',
        '}',
        // Where the box grows from (or shrinks to) for event ev around rect R: the
        // side a sliding layer comes from (or leaves by), the point a layer scales
        // from, the reading start of a text reveal, or else Box Anchor. A layer that
        // fades in finds the box already there.
        'function ab_origin(ev, R, leaving) {',
        '  var mv = ev.mv;',
        '  if (AB_GROW == 2 || !mv || !ev.m) return ab_anchorPt(R);',
        '  var m = ev.m, tOut = leaving ? mv.e : mv.s0, tIn = leaving ? mv.s0 : mv.e, j;',
        '  var a = ab_geom(m, tOut), b = ab_geom(m, tIn);',
        '  var dx = (b.l + b.r - a.l - a.r) / 2, dy = (b.t + b.b - a.t - a.b) / 2, still = Math.abs(dx) < 1 && Math.abs(dy) < 1;',
        // Text typed on (or off) in place: from (or to) the start of the line.
        '  if (mv.reveal && still) return { l: R.l, t: R.t, r: R.l, b: R.b };',
        '  if (!ab_shownAt(m, tOut)) {',
        '    var scaled = false;',
        '    for (j = 0; j < m.chain.length; j++) {',
        '      var sc = ab_xf(m, j, tOut).s;',
        '      if (Math.abs(sc[0]) < 0.5 || Math.abs(sc[1]) < 0.5) scaled = true;',
        '    }',
        '    if (!scaled) return leaving ? ab_anchorPt(R) : R;',
        '    var q0 = ab_xf(m, 0, tIn), q = [q0.p[0], q0.p[1]];',
        '    for (j = 1; j < m.chain.length; j++) q = ab_map(ab_xf(m, j, tIn), q[0], q[1]);',
        '    return ab_point(Math.max(R.l, Math.min(R.r, q[0])), Math.max(R.t, Math.min(R.b, q[1])));',
        '  }',
        '  if (still) return ab_anchorPt(R);',
        // (dx, dy) runs from where it's out to where it's in: coming in, grow from
        // the side it comes from; leaving, shrink toward the side it leaves by.
        '  if (Math.abs(dy) >= Math.abs(dx)) return dy < 0 ? { l: R.l, t: R.b, r: R.r, b: R.b } : { l: R.l, t: R.t, r: R.r, b: R.t };',
        '  return dx > 0 ? { l: R.l, t: R.t, r: R.l, b: R.b } : { l: R.r, t: R.t, r: R.r, b: R.b };',
        '}',
        // Every change of the box, in order: morphs to fit who's in. A layer that
        // leaves keeps its space (held) until the next one comes in, unless a layer
        // is still on its way in: then that morph refits without it. Morphs that
        // start together are ordered by what they do (ab_leads), not by the layers'
        // order in the timeline.
        'function ab_events(members) {',
        '  var items = [], i, j;',
        '  for (i = 0; i < members.length; i++) {',
        '    var M = members[i], tl = M.tl;',
        '    M.own = [];',
        '    for (j = 0; j < tl.segs.length; j++) {',
        '      items.push(tl.segs[j].enter);',
        '      M.own.push(tl.segs[j].enter);',
        '      if (tl.segs[j].b < 1e8 && tl.segs[j].b < AB_OUT) items.push({ m: M, kind: 2, s: tl.segs[j].b, e: tl.segs[j].b, mv: tl.segs[j].leave, seq: AB_SEQ++ });',
        '    }',
        '    for (j = 0; j < tl.repos.length; j++) {',
        '      items.push(tl.repos[j]);',
        '      M.own.push(tl.repos[j]);',
        '    }',
        '    M.own.sort(function (x, y) { return x.s - y.s || x.seq - y.seq; });',
        '  }',
        // Leaves first, then snaps, then the quicker morph, then the one that leads.
        '  var rank = function (x) { return x.kind == 2 ? 0 : (x.snap ? 1 : 2); };',
        '  items.sort(function (x, y) {',
        '    return x.s - y.s || rank(x) - rank(y) || x.e - y.e ||',
        '      (x.kind == 2 ? 0 : (ab_leads(x, y) ? -1 : (ab_leads(y, x) ? 1 : 0))) || x.seq - y.seq;',
        '  });',
        '  var ins = [], held = [], E = [], empty = true;',
        '  var find = function (list, m) {',
        '    for (var n = 0; n < list.length; n++) if (list[n][0] === m) return n;',
        '    return -1;',
        '  };',
        '  var snapshot = function (withHeld) { return withHeld ? ins.concat(held) : ins.slice(0); };',
        '  for (i = 0; i < items.length; i++) {',
        '    var it = items[i], at = find(ins, it.m);',
        '    if (it.kind == 2) {',
        '      if (at < 0) continue;',
        '      var entry = ins.splice(at, 1)[0];',
        // A layer still on its way in (on its curve, or over Morph Time after
        // it appeared): that morph refits without the leaver, on what's left
        // of it.
        '      var run = null;',
        '      for (j = E.length - 1; j >= 0; j--) {',
        '        var x = E[j];',
        '        if (x.kind == 0 && !x.snap && x.s <= it.s && it.s < ab_end(x) - AB_HALF && (!run || ab_end(x) > ab_end(run))) run = x;',
        '      }',
        '      if (run && ins.length) {',
        '        held = [];',
        // (Without a curve to follow, over at least Morph Time.)
        '        var rf = { m: run.m, kind: 3, s: it.s, e: ab_end(run), d: null, p0: 0, inst: true, post: true, snap: false,',
        '          mt: Math.max(ab_end(run) - it.s, ab_mt(it.s)), set: snapshot(false) };',
        '        if (!run.inst) {',
        '          rf.p0 = ab_proj(run.d, it.s);',
        '          if (rf.p0 < 0.95) {',
        '            rf.d = run.d;',
        '            rf.inst = false;',
        '          }',
        '        }',
        '        E.push(rf);',
        '      } else if (!ins.length && AB_COLLAPSE) {',
        '        held = [];',
        '        empty = true;',
        '        var cl = ab_ev(it.m, 4, it.s, it.mv, 0);',
        '        cl.set = null;',
        '        E.push(cl);',
        '      } else {',
        '        held.push(entry);',
        '      }',
        '      continue;',
        '    }',
        '    if (it.kind == 0) {',
        '      if (at >= 0) ins.splice(at, 1);',
        '      var h = find(held, it.m);',
        '      if (h >= 0) held.splice(h, 1);',
        '      held = [];',
        '      ins.push([it.m, it.T, it.Ts]);',
        '      it.set = snapshot(false);',
        '      it.fresh = empty;',
        '      empty = false;',
        '    } else {',
        '      if (at < 0) continue;',
        '      ins[at] = [it.m, it.T, ins[at][2]];',
        '      it.set = snapshot(true);',
        '    }',
        '    E.push(it);',
        '  }',
        '  return E;',
        '}',
        // Which of two morphs that start together goes first (and, into an empty
        // box, decides where it grows from): a curve over a change with none, then
        // the bigger move, the longer one, the bigger layer, the higher one, the one
        // further left.
        'function ab_leads(a, b) {',
        '  if (a.inst != b.inst) return !a.inst;',
        '  var wa = ab_change(a), wb = ab_change(b);',
        '  if (Math.abs(wa - wb) > 0.5) return wa > wb;',
        '  if (Math.abs((a.e - a.s) - (b.e - b.s)) > AB_HALF) return a.e - a.s > b.e - b.s;',
        '  var ga = ab_geom(a.m, a.T < 0 ? a.s : a.T), gb = ab_geom(b.m, b.T < 0 ? b.s : b.T);',
        '  if (Math.abs(ab_area(ga) - ab_area(gb)) > 1) return ab_area(ga) > ab_area(gb);',
        '  if (Math.abs(ga.t - gb.t) > 0.5) return ga.t < gb.t;',
        '  return ga.l < gb.l;',
        '}',
        'function ab_change(ev) {',
        '  if (!ev.mv) return 0;',
        '  var a = ab_geom(ev.m, ev.mv.s0), b = ab_geom(ev.m, ev.mv.e);',
        '  return Math.abs(a.l - b.l) + Math.abs(a.t - b.t) + Math.abs(a.r - b.r) + Math.abs(a.b - b.b);',
        '}',
        // Progress of morph ev at t on one edge. Overshoot may only make the box
        // bigger: a growing edge never goes back past where it started, a
        // shrinking one never past where it ends. gate: nothing starts before it.
        'function ab_prog(ev, t, grows, gate) {',
        '  if (ev.snap) return t >= ev.s ? 1 : 0;',
        '  if (ev.inst) {',
        // No curve: growing edges get there by the change, shrinking edges after it.
        '    if (ev.mt <= 0) return t >= ev.s ? 1 : 0;',
        // (post: a refit runs after its change, whichever way an edge goes.)
        '    var pre = grows && !ev.post, a = pre ? Math.max(ev.s - ev.mt, gate) : ev.s, d = pre ? ev.s - a : ev.mt;',
        '    if (d <= 0) return t >= ev.s ? 1 : 0;',
        '    return ab_ease((t - a) / d, ev.s);',
        '  }',
        '  if (t <= ev.s) return 0;',
        '  if (t >= ev.e) return 1;',
        '  var p = ab_renorm(ab_proj(ev.d, t), ev.p0);',
        '  return grows ? Math.max(p, 0) : Math.min(p, 1);',
        '}',
        // When a morph starts changing the box, and when it's done.
        'function ab_start(ev) { return ev.inst && !ev.snap && !ev.post && ev.kind != 4 ? ev.s - ev.mt : ev.s; }',
        'function ab_end(ev) { return ev.snap ? ev.s : (ev.inst ? ev.s + Math.max(0, ev.mt) : ev.e); }',
        // One morph's change of the box at t, from rect `from` to rect R.
        'function ab_step(box, ev, from, R, t, gate, sign) {',
        '  box.l += sign * (R.l - from.l) * ab_prog(ev, t, R.l < from.l, gate);',
        '  box.t += sign * (R.t - from.t) * ab_prog(ev, t, R.t < from.t, gate);',
        '  box.r += sign * (R.r - from.r) * ab_prog(ev, t, R.r > from.r, gate);',
        '  box.b += sign * (R.b - from.b) * ab_prog(ev, t, R.b > from.b, gate);',
        '}',
        // The box at time t: where it grows from, plus each morph's change on its own
        // curve (so morphs that overlap blend instead of restarting). null: nothing
        // ever comes in.
        'function ab_smart(E, t) {',
        '  var r = ab_morphs(E, t);',
        '  if (r.box) ab_cover(E, r.box, t, r.gates);',
        '  return r.box;',
        '}',
        // The morphs alone. gates: [s, start] of each time the box starts growing
        // from nothing (nothing changes it before then).
        'function ab_morphs(E, t) {',
        '  var box = null, prev = null, gate = -1e9, gates = [], cl = null, i;',
        '  for (i = 0; i < E.length; i++) {',
        '    var ev = E[i], R;',
        '    if (ev.kind == 4) R = prev ? ab_origin(ev, prev, true) : null;',
        '    else R = ab_fit(ev.set, t);',
        '    if (!R) continue;',
        '    var from = prev;',
        '    if (!prev || ev.fresh) {',
        '      from = AB_GROW == 3 ? R : ab_origin(ev, R, false);',
        // Nothing to show before it starts (a box that doesn't grow just
        // appears when the layer does), and nothing else changes it before then.
        '      var grows = from.l != R.l || from.t != R.t || from.r != R.r || from.b != R.b;',
        '      var start = ev.s - (ev.inst && !ev.snap && grows ? ev.mt : 0);',
        '      gate = start;',
        '      gates.push([ev.s, start]);',
        '      if (t < start) {',
        '        var o = ab_anchorPt(from);',
        '        if (!box) box = o;',
        '        prev = prev || o;',
        '        continue;',
        '      }',
        '      if (!box) box = { l: from.l, t: from.t, r: from.r, b: from.b };',
        '      else if (cl && start < ab_end(cl.ev)) {',
        // Back while the box is still collapsing: from where it is then.
        '        ab_step(box, cl.ev, cl.from, cl.R, t, gate, -1);',
        '        ab_step(box, cl.ev, cl.from, cl.R, start, gate, 1);',
        '        from = { l: box.l, t: box.t, r: box.r, b: box.b };',
        '      } else {',
        // Back after collapsing: start where this one grows from.
        '        box.l += from.l - prev.l; box.t += from.t - prev.t; box.r += from.r - prev.r; box.b += from.b - prev.b;',
        '      }',
        '      cl = null;',
        '    }',
        '    ab_step(box, ev, from, R, t, gate, 1);',
        '    if (ev.kind == 4) cl = { ev: ev, from: from, R: R };',
        '    prev = R;',
        '  }',
        '  return { box: box, gates: gates };',
        '}',
        // When a morph is done changing a growing edge.
        'function ab_done(ev) { return ev.snap || ev.inst ? ev.s : ev.e; }',
        // Layers that are in are never cut. Morphs add up, so a layer that gets
        // there before a slower one still coming in would be short by what the
        // slower one has left to go: it makes that up over its own entrance or move,
        // and once it's there the box fits it. A layer that had landed and moves
        // again is kept in the box as it goes.
        'function ab_cover(E, box, t, gates) {',
        '  var cur = null, memo = {}, i, k;',
        // The start of the growth an event belongs to: nothing of it shows before.
        '  var gateOf = function (x) {',
        '    var g = -1e9;',
        '    for (var n = 0; n < gates.length; n++) if (gates[n][0] <= x + 1e-9) g = gates[n][1];',
        '    return g;',
        '  };',
        '  var started = function (ev) { return Math.max(gateOf(ev.s), ab_start(ev)) <= t; };',
        '  for (i = 0; i < E.length; i++) if (started(E[i])) cur = E[i];',
        '  if (!cur || !cur.set) return;',
        '  for (i = 0; i < cur.set.length; i++) {',
        '    var m = cur.set[i][0], own = null, before = null, u = null, c;',
        '    for (k = 0; k < m.own.length; k++) {',
        '      if (!started(m.own[k])) continue;',
        '      before = own;',
        '      own = m.own[k];',
        '    }',
        '    if (!own) continue;',
        '    var gate = gateOf(own.s), done = ab_done(own);',
        '    if (own.kind == 1 && t < done && before && ab_done(before) <= own.s + AB_HALF) {',
        '      c = ab_padded(ab_geom(m, t));',
        '    } else {',
        '      var p = Math.max(0, Math.min(1, ab_prog(own, t, true, gate)));',
        '      if (p <= 0) continue;',
        // Measured where this entrance or move takes it.
        '      var Ts = own.Ts || [own.T];',
        '      for (k = 0; k < Ts.length; k++) {',
        '        var g = ab_geom(m, Ts[k] < 0 ? t : Ts[k]);',
        '        if (g.r - g.l < 0.01 && g.b - g.t < 0.01) continue;',
        '        u = u ? { l: Math.min(u.l, g.l), t: Math.min(u.t, g.t), r: Math.max(u.r, g.r), b: Math.max(u.b, g.b) } : g;',
        '      }',
        '      if (!u) continue;',
        '      c = u = ab_padded(u);',
        '      if (t < done) {',
        // Short by this much when it gets there: make it up as it goes (by
        // time: an overshooting curve gets to 1 before it's done).
        '        if (memo[done] === undefined) memo[done] = ab_morphs(E, done).box;',
        '        var at = memo[done];',
        '        if (!at) continue;',
        '        c = {',
        '          l: Math.max(u.l, box.l - Math.max(0, at.l - u.l) * p), t: Math.max(u.t, box.t - Math.max(0, at.t - u.t) * p),',
        '          r: Math.min(u.r, box.r + Math.max(0, u.r - at.r) * p), b: Math.min(u.b, box.b + Math.max(0, u.b - at.b) * p)',
        '        };',
        '      }',
        '    }',
        '    box.l = Math.min(box.l, c.l);',
        '    box.t = Math.min(box.t, c.t);',
        '    box.r = Math.max(box.r, c.r);',
        '    box.b = Math.max(box.b, c.b);',
        '  }',
        '}',
        // Smart Animate off: wrap whatever is shown right now.
        'function ab_wrap(members, t) {',
        '  var set = [], i;',
        '  for (i = 0; i < members.length; i++) {',
        '    var m = members[i], mode = ab_mode(m.ib, t);',
        '    if (mode == 3 || mode == 4 || !ab_present(m, t)) continue;',
        '    set.push([m, t]);',
        '  }',
        '  return set.length ? ab_fit(set, t) : null;',
        '}',
        // Freeze: runs of the checkbox being on, as [start, end).
        'function ab_runs() {',
        '  var F = null, runs = [];',
        '  try { F = AB_BOX.effect("Freeze")(1); } catch (err) { return runs; }',
        '  var on = (F.numKeys ? F.key(1).value : F.value) > 0, start = -1e9;',
        '  for (var i = 1; i <= F.numKeys; i++) {',
        '    var k = F.key(i), v = k.value > 0;',
        '    if (v && !on) start = k.time;',
        '    if (!v && on) runs.push([start, k.time]);',
        '    on = v;',
        '  }',
        '  if (on) runs.push([start, 1e9]);',
        '  return runs;',
        '}',
        'function ab_mix(a, b, p) {',
        '  if (!a || !b) return b || a;',
        '  return { l: a.l + (b.l - a.l) * p, t: a.t + (b.t - a.t) * p, r: a.r + (b.r - a.r) * p, b: a.b + (b.b - a.b) * p };',
        '}',
        'function ab_solve() {',
        '  if (!AB_BOX) return null;',
        '  var members = ab_members(), E = null, i;',
        '  if (AB_SMART) {',
        '    ab_timelines(members);',
        '    E = ab_events(members);',
        '  }',
        '  var live = function (t) { return AB_SMART ? ab_smart(E, t) : ab_wrap(members, t); };',
        // Freeze holds what's shown when it turns on (frozen from the start: what's
        // shown when it turns off, or the settled box), then eases back.
        '  var runs = ab_runs(), shown = null, held = null, rel = -1e9, r;',
        '  var at = function (t) {',
        '    var v = live(t);',
        '    if (held && t >= rel && t < rel + ab_mt(rel)) v = ab_mix(held, v, ab_ease((t - rel) / ab_mt(rel), rel));',
        '    return v;',
        '  };',
        '  for (i = 0; i < runs.length; i++) {',
        '    r = runs[i];',
        '    if (r[0] > AB_T) break;',
        '    var h;',
        '    if (r[0] <= AB_IN + AB_HALF) h = live(Math.min(r[1], AB_OUT, thisComp.duration) - (r[1] < 1e8 ? 0 : AB_FD));',
        '    else h = at(r[0]);',
        '    if (AB_T < r[1]) return h;',
        '    held = h;',
        '    rel = r[1];',
        '  }',
        '  return at(AB_T);',
        '}',
        // For the In Box button and tests: member idx's timeline as [time, 1 in / 0 out].
        'function ab_switchesOf(idx) {',
        '  var members = ab_members(), sw = [], i, j;',
        '  ab_timelines(members);',
        '  for (i = 0; i < members.length; i++) {',
        '    if (members[i].L.index != idx) continue;',
        '    var segs = members[i].tl.segs;',
        '    for (j = 0; j < segs.length; j++) {',
        '      sw.push([segs[j].a, 1]);',
        '      if (segs[j].b < 1e8) sw.push([segs[j].b, 0]);',
        '    }',
        '  }',
        '  return sw;',
        '}'
    ].join("\n");

    // An empty box sits far off-canvas, so a stroke can't leave a dot.
    var TAILS = {
        size: 'var ab_r = ab_solve();\n(ab_r && ab_r.r - ab_r.l > 0.01 && ab_r.b - ab_r.t > 0.01) ? [ab_r.r - ab_r.l, ab_r.b - ab_r.t] : [0, 0];',
        position: 'var ab_r = ab_solve();\n(ab_r && ab_r.r - ab_r.l > 0.01 && ab_r.b - ab_r.t > 0.01) ? [(ab_r.l + ab_r.r) / 2, (ab_r.t + ab_r.b) / 2] : [-100000, -100000];'
    };

    // AB_HOME: where each layer was (in the box's space) when the box was
    // made around it, as [l, t, r, b, layer index, layer name]. It settles
    // whether a layer that sits still and then makes one big move is coming
    // in or leaving. The engine finds a layer's own home by its name.
    function homeLine(home) {
        if (!home || !home.length) return "var AB_HOME = null;";
        var r = function (v) { return Math.round(v * 100) / 100; }, parts = [];
        for (var i = 0; i < home.length; i++) {
            var vals = [];
            for (var k = 0; k < home[i].length; k++) vals.push(typeof home[i][k] == "string" ? quote(home[i][k]) : r(home[i][k]));
            parts.push("[" + vals.join(", ") + "]");
        }
        return "var AB_HOME = [" + parts.join(", ") + "];";
    }

    // A string as an ES3 literal that stays on one line.
    function quote(text) {
        var out = '"';
        for (var i = 0; i < text.length; i++) {
            var c = text.charAt(i), code = text.charCodeAt(i);
            if (c == '"' || c == "\\") out += "\\" + c;
            else if (code < 32 || code == 0x2028 || code == 0x2029 || code > 126) out += "\\u" + ("000" + code.toString(16)).slice(-4);
            else out += c;
        }
        return out + '"';
    }

    // kind: "size" | "position" (the box's rect).
    function buildExpression(kind, home) {
        return EXPR_TAG + " box: sized from the layers parented to it. Change it in Effect Controls.\n" +
            "var AB_BOX = thisLayer;\n" + homeLine(home) + "\n" + ENGINE + "\n" + TAILS[kind];
    }

    var HOME_RE = /var AB_HOME = (\[.*\]);/;

    // The layout a box was made around, as its expression says: a list of
    // [numbers..., "name"] entries (homeLine's output, read back).
    function homeOf(expression) {
        var m = HOME_RE.exec(expression || ""), out = [], cur = null, s, i = 1, c;
        if (!m) return null;
        s = m[1];
        while (i < s.length - 1) {
            c = s.charAt(i);
            if (c == "[") cur = [];
            else if (c == "]") {
                if (cur && cur.length >= 4) out.push(cur);
                cur = null;
            } else if (c == '"' && cur) {
                var text = "";
                for (i++; i < s.length && s.charAt(i) != '"'; i++) {
                    if (s.charAt(i) == "\\") {
                        i++;
                        if (s.charAt(i) == "u") {
                            text += String.fromCharCode(parseInt(s.substr(i + 1, 4), 16));
                            i += 4;
                        } else text += s.charAt(i);
                    } else text += s.charAt(i);
                }
                cur.push(text);
            } else if (/[-0-9.]/.test(c) && cur) {
                var j = i;
                while (j < s.length && /[-0-9.eE+]/.test(s.charAt(j))) j++;
                cur.push(parseFloat(s.substring(i, j)));
                i = j - 1;
            }
            i++;
        }
        return out.length ? out : null;
    }

    // Where each of `layers` is now, in the box's space, with its index and
    // name. A layer that isn't showing now (outside its in and out points,
    // or transparent) has no home.
    function homesOf(comp, box, layers) {
        var out = [], t = comp.time;
        for (var i = 0; i < layers.length; i++) {
            var L = layers[i], shown = t >= Math.min(L.inPoint, L.outPoint) && t < Math.max(L.inPoint, L.outPoint);
            try { if (L.property("ADBE Transform Group").property("ADBE Opacity").valueAtTime(t, false) <= 1) shown = false; } catch (err) {}
            if (!shown) continue;
            var b = measure(comp, box, [L], box);
            if (b.r > b.l) out.push([b.l, b.t, b.r, b.b, L.index, L.name]);
        }
        return out;
    }

    // A temporary expression on the box that reports one member's in/out
    // switches: [time, 1 = in / 0 = out] number k, or [-1, -1].
    function buildSwitchProbe(memberIndex, k, home) {
        return "var AB_BOX = thisLayer;\n" + homeLine(home) + "\n" + ENGINE + "\n" +
            "var ab_sw = ab_switchesOf(" + memberIndex + ");\n" +
            "ab_sw.length > " + k + " ? ab_sw[" + k + "] : [-1, -1];";
    }

    // Gradient Start / End Point: the native value is a percentage of the box,
    // so the gradient stretches with it. 0,0 is the center, -50,0 the left
    // edge, 50,50 the bottom-right corner.
    function gradientPointExpression() {
        return [
            PAINT_TAG + ": Start/End Point are % of the box (0,0 = center, -50,0 = left edge, 50,50 = bottom right).",
            'var ab_rect = thisLayer.content("' + RIG_GROUP + '").content("' + RECT_NAME + '");',
            "var ab_s = ab_rect.size.value, ab_p = ab_rect.position.value;",
            "[ab_p[0] + value[0] / 100 * ab_s[0], ab_p[1] + value[1] / 100 * ab_s[1]];"
        ].join("\n");
    }

    // Native Start / End Point percentages for a gradient type (2 linear,
    // 3 radial) and angle (0 = up, 90 = left to right), for a box of size
    // w x h (the angle is true for that shape).
    function gradientPoints(type, angle, w, h) {
        if (type == 3) return [[0, 0], [50, 50]];
        var a = angle * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
        if (w > 0 && h > 0) {
            dx /= w;
            dy /= h;
        }
        var half = 50 / Math.max(Math.abs(dx), Math.abs(dy));
        var round = function (v) { return Math.round(v * 1000) / 1000; };
        return [[round(-dx * half), round(-dy * half)], [round(dx * half), round(dy * half)]];
    }

    // ------------------------------------------------------------------
    // Settings (persisted between sessions)
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Settings (persisted between sessions)
    // ------------------------------------------------------------------
    function parseSetting(raw, def) {
        if (def instanceof Array) {
            var parts = String(raw).split(","), out = [];
            for (var i = 0; i < def.length; i++) {
                var v = parseFloat(parts[i]);
                out.push(isNaN(v) ? def[i] : v);
            }
            return out;
        }
        var n = parseFloat(raw);
        return isNaN(n) ? def : n;
    }

    function loadSettings() {
        var s = {};
        for (var k in DEFAULTS) {
            s[k] = DEFAULTS[k];
            try {
                if (app.settings.haveSetting(SETTINGS_SECTION, k)) {
                    s[k] = parseSetting(app.settings.getSetting(SETTINGS_SECTION, k), DEFAULTS[k]);
                }
            } catch (err) {}
        }
        return s;
    }

    function saveSettings(s) {
        for (var k in s) {
            try {
                app.settings.saveSetting(SETTINGS_SECTION, k, (s[k] instanceof Array) ? s[k].join(",") : String(s[k]));
            } catch (err) {}
        }
    }

    function copySettings(s) {
        var out = {};
        for (var k in s) out[k] = s[k];
        return out;
    }

    // ------------------------------------------------------------------
    // Layer helpers
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Layer helpers
    // ------------------------------------------------------------------
    function activeComp() {
        var comp = app.project.activeItem;
        if (!(comp instanceof CompItem)) {
            alert("Open a composition and select some layers first.", SCRIPT_NAME);
            return null;
        }
        return comp;
    }

    function isUsable(layer) {
        if (!(layer instanceof AVLayer || layer instanceof TextLayer || layer instanceof ShapeLayer)) return false;
        if (layer.nullLayer || layer.adjustmentLayer || !layer.hasVideo) return false;
        return true;
    }

    function shapeGroup(layer, name) {
        if (!(layer instanceof ShapeLayer)) return null;
        try {
            return layer.property("ADBE Root Vectors Group").property(name) || null;
        } catch (err) {
            return null;
        }
    }

    function rigGroup(layer) {
        return shapeGroup(layer, RIG_GROUP);
    }

    // Any AutoBox box (1.x, 2.x or 3.x): the AutoBox shape group plus its
    // Padding control (Release removes the controls).
    function isBox(layer) {
        return rigGroup(layer) !== null && findControl(layer, "Padding") !== null;
    }

    // A box made by AutoBox 1.x or 2.x: its rect still runs the old engine, or
    // it still has the old Layout control.
    function isOldBox(layer) {
        if (!isBox(layer)) return false;
        if (findControl(layer, "Layout")) return true;
        var e = rigParts(layer).size.expression;
        return e.indexOf("AB_M.push(") >= 0 || e.indexOf("AB_MODE") >= 0;
    }

    function isLegacyBox(box) {
        return rigParts(box).size.expression.indexOf("AB_M.push(") >= 0;
    }

    // The layer AutoBox 2.x drew a box's stroke on.
    function isOldStrokeLayer(layer) {
        return shapeGroup(layer, OLD_STROKE_GROUP) !== null;
    }

    function oldStrokeLayerOf(comp, box) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layer.parent && layer.parent.index == box.index && isOldStrokeLayer(layer)) return layer;
        }
        return null;
    }

    // The box's rect: "Box Rect" (a rectangle the user added to the group
    // is theirs), else the first rectangle (boxes from before it had a name).
    function rigParts(box) {
        var group = rigGroup(box), vecs = group.property("ADBE Vectors Group");
        var rect = vecs.property(RECT_NAME);
        if (!rect || rect.matchName != "ADBE Vector Shape - Rect") rect = vecs.property("ADBE Vector Shape - Rect");
        return {
            group: group,
            size: rect.property("ADBE Vector Rect Size"),
            position: rect.property("ADBE Vector Rect Position"),
            roundness: rect.property("ADBE Vector Rect Roundness")
        };
    }

    function positionProps(layer) {
        var tr = layer.property("ADBE Transform Group");
        var pos = tr.property("ADBE Position");
        if (pos.dimensionsSeparated) return [tr.property("ADBE Position_0"), tr.property("ADBE Position_1")];
        return [pos];
    }

    function isRigExpression(prop) {
        return prop.expression.indexOf(EXPR_TAG) === 0;
    }

    function hasRigExpression(layer) {
        var props = positionProps(layer);
        for (var i = 0; i < props.length; i++) {
            if (isRigExpression(props[i])) return true;
        }
        return false;
    }

    // The nearest box above this layer in its parent chain, or null.
    function ownerBox(layer) {
        for (var p = layer.parent; p; p = p.parent) {
            if (isBox(p)) return p;
        }
        return null;
    }

    function sameLayer(a, b) {
        return !!a && !!b && a.index == b.index;
    }

    // Layers in the box: everything whose nearest box ancestor is `box`
    // (layers inside a nested box belong to that box instead).
    function boxMembers(comp, box) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layer.index != box.index && !isOldStrokeLayer(layer) && sameLayer(ownerBox(layer), box)) out.push(layer);
        }
        return out;
    }

    // Layers parented straight to the box.
    function directMembers(comp, box) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (sameLayer(layer.parent, box) && isUsable(layer) && !isOldStrokeLayer(layer)) out.push(layer);
        }
        return out;
    }

    function containsLayer(list, layer) {
        for (var i = 0; i < list.length; i++) {
            if (list[i].index == layer.index) return true;
        }
        return false;
    }

    // True if `layer` is `other` or one of its parents.
    function isAncestor(layer, other) {
        for (var p = other; p; p = p.parent) {
            if (p.index == layer.index) return true;
        }
        return false;
    }

    function nameTaken(comp, name, self) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var other = comp.layer(i);
            if (other.index != self.index && other.name == name) return true;
        }
        return false;
    }

    function uniqueBoxName(comp, box) {
        var n = 1;
        while (nameTaken(comp, "AutoBox " + n, box)) n++;
        return "AutoBox " + n;
    }

    function setExpression(prop, expr) {
        prop.expression = expr;
        try { prop.expressionEnabled = true; } catch (err) {}
    }

    // (Re)apply the box's expressions. Members never get any. home: the
    // layout it's made around (leave it out to keep the box's own).
    function rigBox(box, home) {
        var parts = rigParts(box);
        if (home === undefined) home = homeOf(parts.size.expression);
        setExpression(parts.size, buildExpression("size", home));
        setExpression(parts.position, buildExpression("position", home));
    }



    // Evaluate the box's expressions and report any errors.
    function checkRig(comp, box) {
        var props = [], errors = [], i, parts = rigParts(box);
        props.push(parts.size, parts.position);
        var items = vectors(box, RIG_GROUP);
        for (i = 1; i <= items.numProperties; i++) {
            var item = items.property(i);
            if (item.matchName == "ADBE Vector Graphic - G-Fill" || item.matchName == "ADBE Vector Graphic - G-Stroke") {
                props.push(item.property("ADBE Vector Grad Start Pt"), item.property("ADBE Vector Grad End Pt"));
            }
        }
        for (i = 0; i < props.length; i++) {
            try { props[i].valueAtTime(comp.time, false); } catch (err) {}
            if (props[i].expressionError) errors.push(props[i].name + ": " + props[i].expressionError);
        }
        if (errors.length) {
            alert(box.name + ": AutoBox could not evaluate some expressions:\n\n" + errors.join("\n"), SCRIPT_NAME);
        }
    }

    function layerTimeRange(comp, layer) {
        var fd = comp.frameDuration;
        var t0 = Math.max(0, layer.inPoint);
        var t1 = Math.min(comp.duration, layer.outPoint) - fd;
        return [t0, Math.max(t0, t1)];
    }

    function sameValue(a, b) {
        if (a instanceof Array) {
            for (var i = 0; i < a.length; i++) {
                if (Math.abs(a[i] - b[i]) > 1e-6) return false;
            }
            return true;
        }
        return Math.abs(a - b) <= 1e-6;
    }

    // Replace an expression with its result: nothing when it was passing the
    // value through, a static value when it never changes, otherwise one
    // linear keyframe on every frame where the value changes.
    function bakeProperty(comp, prop, range) {
        if (!prop.expression) return;
        var fd = comp.frameDuration;
        var count = Math.max(1, Math.round((range[1] - range[0]) / fd) + 1);
        var times = [], values = [], changed = false, varies = false, i;
        try {
            for (i = 0; i < count; i++) {
                var t = range[0] + i * fd, v = prop.valueAtTime(t, false);
                if (!changed && !sameValue(v, prop.valueAtTime(t, true))) changed = true;
                if (i > 0 && !sameValue(v, values[i - 1])) varies = true;
                times.push(t);
                values.push(v);
            }
        } catch (err) {
            changed = false; // a broken expression has nothing worth keeping
        }
        prop.expression = "";
        if (!changed) return;
        while (prop.numKeys > 0) prop.removeKey(prop.numKeys);
        if (!varies) {
            prop.setValue(values[0]);
            return;
        }
        var keyTimes = [], keyValues = [];
        for (i = 0; i < count; i++) {
            if (i > 0 && i < count - 1 && sameValue(values[i], values[i - 1]) && sameValue(values[i], values[i + 1])) continue;
            keyTimes.push(times[i]);
            keyValues.push(values[i]);
        }
        prop.setValuesAtTimes(keyTimes, keyValues);
        for (i = 1; i <= prop.numKeys; i++) {
            prop.setInterpolationTypeAtKey(i, KeyframeInterpolationType.LINEAR, KeyframeInterpolationType.LINEAR);
            if (prop.isSpatial) {
                var zero = [];
                for (var d = 0; d < keyValues[0].length; d++) zero.push(0);
                try {
                    prop.setSpatialAutoBezierAtKey(i, false);
                    prop.setSpatialContinuousAtKey(i, false);
                    prop.setSpatialTangentsAtKey(i, zero, zero);
                } catch (err) {}
            }
        }
    }

    // Bake and clear the layout expression(s) AutoBox put on a layer.
    function releaseMember(comp, member) {
        var props = positionProps(member), range = layerTimeRange(comp, member);
        for (var i = 0; i < props.length; i++) {
            if (isRigExpression(props[i])) bakeProperty(comp, props[i], range);
        }
    }

    // ------------------------------------------------------------------
    // Effect Controls
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Building the box layer
    // ------------------------------------------------------------------
    function addDropdown(fx, items) {
        var effect = fx.addProperty(CONTROL_MATCH.dropdown);
        var menu = effect.property(1);
        if (typeof menu.setPropertyParameters !== "function") {
            effect.remove();
            throw new Error("Dropdown menus need After Effects 17.0.1 or newer");
        }
        // setPropertyParameters invalidates `effect`; reach it again through the menu.
        return menu.setPropertyParameters(items).propertyGroup(1);
    }

    function addControl(fx, control) {
        if (control.type == "dropdown") {
            try {
                return addDropdown(fx, control.items);
            } catch (err) {
                // After Effects before 17.0.1: fall back to a slider (1, 2, 3...).
                return fx.addProperty(CONTROL_MATCH.slider);
            }
        }
        return fx.addProperty(CONTROL_MATCH[control.type]);
    }

    function controlValue(control, v) {
        if (control.type == "color") return [v[0], v[1], v[2], 1];
        if (control.type == "dropdown") return Math.max(1, Math.min(control.items.length, Math.round(v)));
        if (control.type == "checkbox") return v ? 1 : 0;
        return v;
    }

    function writeControl(prop, control, v, t) {
        var value = controlValue(control, v);
        if (prop.numKeys > 0) prop.setValueAtTime(t, value);
        else prop.setValue(value);
    }

    function initialValue(control, values) {
        return control.key ? values[control.key] : control.initial;
    }

    function addControls(box, values, t) {
        var fx = box.property("ADBE Effect Parade");
        for (var i = 0; i < CONTROLS.length; i++) {
            var effect = addControl(fx, CONTROLS[i]);
            effect.name = CONTROLS[i].name;
            writeControl(effect.property(1), CONTROLS[i], initialValue(CONTROLS[i], values), t);
        }
    }

    function findControl(box, name) {
        try {
            return box.property("ADBE Effect Parade").property(name) || null;
        } catch (err) {
            return null;
        }
    }

    // Add any controls a box is missing (boxes made by older versions).
    function ensureControls(box, values, t) {
        var fx = box.property("ADBE Effect Parade");
        for (var i = 0; i < CONTROLS.length; i++) {
            if (findControl(box, CONTROLS[i].name)) continue;
            var effect = addControl(fx, CONTROLS[i]);
            effect.name = CONTROLS[i].name;
            writeControl(effect.property(1), CONTROLS[i], initialValue(CONTROLS[i], values), t);
        }
    }

    // skipAnimated: leave keyframed controls alone rather than adding a key.
    function setControls(box, values, t, skipAnimated) {
        for (var i = 0; i < CONTROLS.length; i++) {
            var c = CONTROLS[i];
            if (!c.key) continue;
            var effect = findControl(box, c.name);
            if (!effect || (skipAnimated && effect.property(1).numKeys > 0)) continue;
            writeControl(effect.property(1), c, values[c.key], t);
        }
    }

    // ------------------------------------------------------------------
    // The box's look: plain native shape items
    //
    // Contents > AutoBox holds the rect and, in this order, Stroke, Gradient
    // Stroke, Fill and Gradient Fill: strokes above fills. All four always
    // exist; the ones not in use are switched off (their eyeball). Colors,
    // widths, opacity and Roundness are native and yours to edit or animate.
    // Only the rect's Size / Position and the gradients' Start / End Point
    // carry expressions. Scripts can't set gradient colors, so a new gradient
    // is After Effects' default white to black: use Edit Gradient.
    // ------------------------------------------------------------------
    var PAINT = [
        { name: "Stroke", match: "ADBE Vector Graphic - Stroke" },
        { name: "Gradient Stroke", match: "ADBE Vector Graphic - G-Stroke" },
        { name: "Fill", match: "ADBE Vector Graphic - Fill" },
        { name: "Gradient Fill", match: "ADBE Vector Graphic - G-Fill" }
    ];

    // A shape group's contents, looked up from the layer every time. Adding or
    // removing a shape item invalidates references to its siblings, so no
    // reference to an item is kept across a change.
    function vectors(layer, groupName) {
        return layer.property("ADBE Root Vectors Group").property(groupName).property("ADBE Vectors Group");
    }

    // Find a shape item by name, adding it if it's missing. Items are only
    // ever appended, never moved: reordering shape items with moveTo makes
    // After Effects fail an internal check on the next edit ("internal
    // verification failure, sorry!").
    function ensureItem(layer, groupName, name, matchName) {
        if (vectors(layer, groupName).property(name)) return;
        vectors(layer, groupName).addProperty(matchName).name = name;
    }

    // Remove the items `test` picks. The scan runs top down and starts over
    // after each removal, so no reference outlives a change above it.
    function removeItems(layer, groupName, test) {
        for (var found = true; found;) {
            found = false;
            var contents = vectors(layer, groupName);
            for (var i = 1; i <= contents.numProperties; i++) {
                if (!test(contents.property(i))) continue;
                contents.property(i).remove();
                found = true;
                break;
            }
        }
    }

    function buildShape(box) {
        var group = box.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = RIG_GROUP;
        vectors(box, RIG_GROUP).addProperty("ADBE Vector Shape - Rect").name = RECT_NAME;
        for (var i = 0; i < PAINT.length; i++) ensureItem(box, RIG_GROUP, PAINT[i].name, PAINT[i].match);
    }

    // Set a native value unless it's keyframed (then it's the user's).
    function setNative(prop, value) {
        if (!prop || prop.numKeys > 0) return;
        prop.setValue(value);
    }

    function setEnabled(item, on) {
        try { item.enabled = on; } catch (err) {}
    }

    // Write the panel's look onto the box: values, which items are on,
    // gradient types and directions. Gradient colors are never touched.
    function paintBox(box, s) {
        var i, item = function (name) { return vectors(box, RIG_GROUP).property(name); };
        for (i = 0; i < PAINT.length; i++) ensureItem(box, RIG_GROUP, PAINT[i].name, PAINT[i].match);
        setNative(item(RECT_NAME).property("ADBE Vector Rect Roundness"), Math.max(0, s.radius));

        var fillType = Math.round(s.fillType), strokeType = Math.round(s.strokeType);
        var fill = item("Fill");
        setNative(fill.property("ADBE Vector Fill Color"), [s.fillColor[0], s.fillColor[1], s.fillColor[2], 1]);
        setNative(fill.property("ADBE Vector Fill Opacity"), s.fillOpacity);
        setEnabled(fill, fillType == 1);
        var size = rigParts(box).size.value;
        paintGradient(box, "Gradient Fill", fillType, s.fillAngle, s.fillOpacity, null, size);
        setEnabled(item("Gradient Fill"), fillType != 1);

        var stroke = item("Stroke");
        setNative(stroke.property("ADBE Vector Stroke Color"), [s.strokeColor[0], s.strokeColor[1], s.strokeColor[2], 1]);
        setNative(stroke.property("ADBE Vector Stroke Width"), Math.max(0, s.strokeWidth));
        setNative(stroke.property("ADBE Vector Stroke Opacity"), s.strokeOpacity);
        setEnabled(stroke, strokeType == 1 && drawn(stroke));
        paintGradient(box, "Gradient Stroke", strokeType, s.strokeAngle, s.strokeOpacity, Math.max(0, s.strokeWidth), size);
        setEnabled(item("Gradient Stroke"), strokeType != 1 && drawn(item("Gradient Stroke")));
    }

    // Whether a stroke draws anything: its width, or one of its width keys,
    // is above 0.
    function drawn(stroke) {
        var w = stroke.property("ADBE Vector Stroke Width");
        if (!w.numKeys) return w.value > 0;
        for (var i = 1; i <= w.numKeys; i++) {
            if (w.keyValue(i) > 0) return true;
        }
        return false;
    }

    // A gradient not in use still gets a type and points that span the box,
    // so switching it on by its eyeball just works.
    function paintGradient(box, name, type, angle, opacity, width, size) {
        var g = vectors(box, RIG_GROUP).property(name);
        setNative(g.property("ADBE Vector Grad Type"), type == 3 ? 2 : 1);
        var pts = gradientPoints(type == 3 ? 3 : 2, angle, size[0], size[1]);
        setNative(g.property("ADBE Vector Grad Start Pt"), pts[0]);
        setNative(g.property("ADBE Vector Grad End Pt"), pts[1]);
        var opacityProp = g.property(name == "Gradient Fill" ? "ADBE Vector Fill Opacity" : "ADBE Vector Stroke Opacity");
        setNative(opacityProp, opacity);
        if (width !== null) setNative(g.property("ADBE Vector Stroke Width"), width);
        fitGradient(box, name);
    }

    // The gradient-fit expression, unless the user put their own there.
    function fitGradient(box, name) {
        var props = ["ADBE Vector Grad Start Pt", "ADBE Vector Grad End Pt"];
        for (var i = 0; i < props.length; i++) {
            var p = vectors(box, RIG_GROUP).property(name).property(props[i]);
            if (!p.expression || p.expression.indexOf(PAINT_TAG) === 0) setExpression(p, gradientPointExpression());
        }
    }

    // Make the box cover its layers' time (a time-reversed layer has its in
    // point after its out point). extend: only ever make it longer, and never
    // move its start time (that would slide its keyframes).
    function fitTiming(box, members, extend) {
        var tin = Infinity, tout = -Infinity;
        for (var i = 0; i < members.length; i++) {
            tin = Math.min(tin, members[i].inPoint, members[i].outPoint);
            tout = Math.max(tout, members[i].inPoint, members[i].outPoint);
        }
        if (extend) {
            tin = Math.min(tin, box.inPoint);
            tout = Math.max(tout, box.outPoint);
        }
        try {
            if (!extend && tin < box.startTime) box.startTime = tin;
            box.outPoint = tout;
            box.inPoint = tin;
        } catch (err) {}
    }

    function lowestLayer(layers) {
        var lowest = layers[0];
        for (var i = 1; i < layers.length; i++) {
            if (layers[i].index > lowest.index) lowest = layers[i];
        }
        return lowest;
    }

    // Filter a selection down to layers that can join `box` (null = new box).
    function pickMembers(layers, box) {
        var out = [], skipped = [];
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (box && layer.index == box.index) continue;
            if (isOldStrokeLayer(layer)) {
                // Selected along with its own box, it simply rides along.
                var withBox = layer.parent && (containsLayer(layers, layer.parent) || sameLayer(layer.parent, box));
                if (!withBox) skipped.push(layer.name + " — it draws an AutoBox 2 box's stroke; select its box instead");
                continue;
            }
            if (!isUsable(layer)) {
                skipped.push(layer.name + " — cameras, lights, nulls, adjustment and audio layers can't be boxed");
                continue;
            }
            if (layer.locked) {
                skipped.push(layer.name + " — layer is locked");
                continue;
            }
            if (box && isAncestor(layer, box)) {
                skipped.push(layer.name + " — it contains " + box.name);
                continue;
            }
            out.push(layer);
        }
        if (skipped.length) alert("Skipped:\n" + skipped.join("\n"), SCRIPT_NAME);
        return out;
    }

    // The layers whose parent isn't also in `layers` (the rest ride along).
    function topLevel(layers) {
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            if (!(layers[i].parent && containsLayer(layers, layers[i].parent))) out.push(layers[i]);
        }
        return out;
    }

    // The one parent all `layers` share, or null.
    function sharedParent(layers) {
        var p = layers.length ? layers[0].parent : null;
        for (var i = 1; i < layers.length && p; i++) {
            if (!sameLayer(layers[i].parent, p)) return null;
        }
        return p || null;
    }

    // Parent links that boxing `layers` would replace (other than `keep`).
    function linksToCut(layers, keep) {
        var out = [];
        for (var i = 0; i < layers.length; i++) {
            var p = layers[i].parent;
            if (p && !sameLayer(p, keep)) out.push(layers[i].name + " (parented to " + p.name + ")");
        }
        return out;
    }

    function confirmCut(cut) {
        return !cut.length || confirm("These layers are parented to other layers. Boxing them replaces those links:\n\n" +
            cut.join("\n") + "\n\nContinue?", false, SCRIPT_NAME);
    }

    // Replace a position that an AutoBox 1.x/2.x layout expression drives with
    // what it shows over the layer's time: nothing when it passed the value
    // through, a static value when it never changes, otherwise keyframes.
    // Re-parenting compensates the stored value, not the expression's result,
    // so without this a layer would jump.
    function freeze(comp, layer) {
        var props = positionProps(layer);
        for (var i = 0; i < props.length; i++) {
            if (isRigExpression(props[i])) bakeProperty(comp, props[i], layerTimeRange(comp, layer));
        }
    }

    // Parent the top-level layers to the box (the rest ride along). A layer
    // leaving another box takes that box off as its matte, and its riders'
    // (not when the new box sits inside the old one: it's still in it).
    function adopt(comp, box, layers) {
        var top = topLevel(layers), moving = [], i, j;
        for (i = 0; i < top.length; i++) {
            if (!sameLayer(top[i].parent, box)) moving.push(top[i]);
        }
        for (i = 0; i < moving.length; i++) freeze(comp, moving[i]);
        for (i = 0; i < moving.length; i++) {
            var old = ownerBox(moving[i]);
            if (old && !isAncestor(old, box)) {
                for (j = 1; j <= comp.numLayers; j++) {
                    if (isAncestor(moving[i], comp.layer(j))) unmatte(comp.layer(j), old);
                }
            }
            moving[i].parent = box;
        }
    }

    // Comp-space bounds of `layers` at the current time, via a temporary
    // expression (scripting has no toComp).
    // space: measure in this layer's space instead of the comp's.
    function measure(comp, box, layers, space) {
        var ids = [];
        for (var i = 0; i < layers.length; i++) ids.push(layers[i].index);
        var code = [
            'var ids = [' + ids.join(", ") + '];',
            'var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;',
            'for (var i = 0; i < ids.length; i++) {',
            '  var L = thisComp.layer(ids[i]), ext = true;',
            '  try { ext = L.text.sourceText === undefined; } catch (err) { ext = true; }',
            // sourceRectAtTime reads its time as the layer's own time.
            '  var lt = time;',
            '  try { lt = L.sourceTime(time); } catch (err) { lt = time - L.startTime; }',
            '  var sr = L.sourceRectAtTime(lt, ext);',
            '  var xs = [sr.left, sr.left + sr.width], ys = [sr.top, sr.top + sr.height];',
            '  for (var k = 0; k < 4; k++) {',
            '    var p = ' + (space ? 'thisComp.layer(' + space.index + ').fromComp(' : '(') + 'L.toComp([xs[k % 2], ys[Math.floor(k / 2)]]));',
            '    l = Math.min(l, p[0]); t = Math.min(t, p[1]); r = Math.max(r, p[0]); b = Math.max(b, p[1]);',
            '  }',
            '}',
            '(l > r) ? [0, 0] : %OUT%;'
        ].join("\n");
        var fx = box.property("ADBE Effect Parade");
        var probe = fx.addProperty("ADBE Point Control");
        var index = probe.propertyIndex, point = probe.property(1);
        setExpression(point, code.replace("%OUT%", "[l, t]"));
        var topLeft = point.valueAtTime(comp.time, false);
        setExpression(point, code.replace("%OUT%", "[r, b]"));
        var bottomRight = point.valueAtTime(comp.time, false);
        fx.property(index).remove();
        return { l: topLeft[0], t: topLeft[1], r: bottomRight[0], b: bottomRight[1] };
    }

    // Where the box layer should sit so the chosen Box Anchor lands on the
    // padded bounds of `b` (keeps the selection from jumping when parented).
    function anchorPoint(b, s) {
        var anchor = Math.max(0, Math.min(8, Math.round(s.anchor) - 1)), ax = anchor % 3, ay = Math.floor(anchor / 3);
        var l = b.l - (s.padding + s.extraLeft), r = b.r + (s.padding + s.extraRight);
        var t = b.t - (s.padding + s.extraTop), bot = b.b + (s.padding + s.extraBottom);
        var grow = function (lo, hi, min, a) {
            var d = min - (hi - lo);
            if (d <= 0) return [lo, hi];
            return a == 0 ? [lo, hi + d] : (a == 1 ? [lo - d / 2, hi + d / 2] : [lo - d, hi]);
        };
        var gx = grow(l, r, s.minWidth, ax), gy = grow(t, bot, s.minHeight, ay);
        return [gx[0] + (gx[1] - gx[0]) * ax / 2, gy[0] + (gy[1] - gy[0]) * ay / 2];
    }

    function deselectAll(comp) {
        for (var i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
    }

    // ------------------------------------------------------------------
    // Converting boxes made by AutoBox 1.x / 2.x
    //
    // Old boxes keep working as they are (their expressions are
    // self-contained). Apply to Box / Add to Box offer to convert them.
    // ------------------------------------------------------------------
    var LEGACY_MEMBER_RE = /AB_M\.push\(thisComp\.layer\("((?:[^"\\]|\\.)*)"\)\)/g;

    var PAINT_MATCHES = {
        "ADBE Vector Graphic - Fill": true,
        "ADBE Vector Graphic - G-Fill": true,
        "ADBE Vector Graphic - Stroke": true,
        "ADBE Vector Graphic - G-Stroke": true
    };
    // Paint items AutoBox 2.x put in the box (anything else is the user's).
    var OLD_PAINT = { "Stroke": true, "Fill": true, "Linear Gradient Fill": true, "Radial Gradient Fill": true };
    // What Release removes from an old box (2.x kept its paint controls).
    var OLD_LAYOUT_CONTROLS = ["Layout", "Gap", "Align", "Justify", "Box Anchor", "Padding", "Extra Top", "Extra Right",
        "Extra Bottom", "Extra Left", "Corner Radius", "Min Width", "Min Height", "Ignore Hidden"];

    // Layers a 1.x box tracked by name (1.x left a layer's own parent alone,
    // so some of them aren't parented to the box).
    function legacyMembers(comp, box) {
        var expr = rigParts(box).size.expression, out = [], m;
        LEGACY_MEMBER_RE.lastIndex = 0;
        while ((m = LEGACY_MEMBER_RE.exec(expr)) !== null) {
            var name = m[1].replace(/\\(.)/g, "$1");
            for (var i = 1; i <= comp.numLayers; i++) {
                var layer = comp.layer(i);
                if (layer.name == name && layer.index != box.index) {
                    if (!layer.locked && !containsLayer(out, layer)) out.push(layer);
                    break;
                }
            }
        }
        return out;
    }

    // Parent links that adopting a 1.x box's members would cut.
    function legacyCuts(comp, box) {
        var out = [], members = legacyMembers(comp, box);
        for (var i = 0; i < members.length; i++) {
            if (members[i].parent && !isAncestor(box, members[i])) out.push(members[i].name + " (parented to " + members[i].parent.name + ")");
        }
        return out;
    }

    // Bring a 1.x box's name-tracked members into the box. Members outside
    // the box's parent chain are parented to it (adoptOutside) or pinned where
    // they are, outside the box.
    function adoptLegacyMembers(comp, box, adoptOutside) {
        var members = legacyMembers(comp, box), moved = [], left = [];
        for (var i = 0; i < members.length; i++) {
            var layer = members[i];
            freeze(comp, layer);
            if (isAncestor(box, layer)) continue;
            if (adoptOutside) {
                layer.parent = box;
                moved.push(layer.name);
            } else {
                left.push(layer.name);
            }
        }
        return { moved: moved, left: left };
    }

    // A paint item AutoBox 1.x made: its color reads the box's own controls
    // through the old expression.
    function isLegacyPaint(item) {
        var color = item.property("ADBE Vector Fill Color") || item.property("ADBE Vector Stroke Color");
        if (!color) return false;
        var e = color.expression;
        return e.indexOf(PAINT_TAG) !== 0 && (e.indexOf('effect("Fill Color")') >= 0 || e.indexOf('effect("Stroke Color")') >= 0);
    }

    function isOldPaint(item) {
        return !!PAINT_MATCHES[item.matchName] && (!!OLD_PAINT[item.name] || isLegacyPaint(item));
    }

    // An old control's value at time t (colors as RGB), or `fallback`.
    function oldControl(box, name, t, fallback) {
        var effect = findControl(box, name);
        if (!effect) return fallback;
        var v = effect.property(1).valueAtTime(t, false);
        return (v instanceof Array) ? [v[0], v[1], v[2]] : v;
    }

    // Carry an old control's keyframes over to the native property, hold
    // keys and easing included.
    function carryKeys(box, name, prop) {
        var effect = findControl(box, name);
        if (!effect || !prop) return;
        var src = effect.property(1);
        for (var i = 1; i <= src.numKeys; i++) prop.setValueAtTime(src.keyTime(i), src.keyValue(i));
        for (i = 1; i <= src.numKeys && i <= prop.numKeys; i++) {
            try {
                var out = src.keyOutInterpolationType(i), inType = out;
                try { inType = src.keyInInterpolationType(i); } catch (err) {}
                prop.setInterpolationTypeAtKey(i, inType, out);
            } catch (err2) {}
            try { prop.setTemporalEaseAtKey(i, src.keyInTemporalEase(i), src.keyOutTemporalEase(i)); } catch (err3) {}
        }
    }

    // An old control's largest value over time (its keys, or its value).
    function oldMax(box, name, t, fallback) {
        var effect = findControl(box, name);
        if (!effect || !effect.property(1).numKeys) return oldControl(box, name, t, fallback);
        var src = effect.property(1), v = -Infinity;
        for (var i = 1; i <= src.numKeys; i++) v = Math.max(v, src.keyValue(i));
        return v;
    }

    function isKeyed(box, name) {
        var effect = findControl(box, name);
        return !!effect && effect.property(1).numKeys > 0;
    }

    // Unlock `layers` while fn runs, then lock them again.
    function unlocked(layers, fn) {
        var locked = [], i;
        for (i = 0; i < layers.length; i++) {
            if (layers[i].locked) {
                layers[i].locked = false;
                locked.push(layers[i]);
            }
        }
        try {
            return fn();
        } finally {
            for (i = 0; i < locked.length; i++) {
                try { locked[i].locked = true; } catch (err) {}
            }
        }
    }

    // Give an old box the 3.0 rig and native paint, keeping its layout
    // settings, colors and widths.
    function convertBox(comp, box, adoptOutside) {
        var t = comp.time, s = copySettings(DEFAULTS), notes = [], i;
        var result = { name: box.name, moved: [], left: [], notes: notes };
        s.radius = oldControl(box, "Corner Radius", t, 0);
        s.fillType = Math.round(oldControl(box, "Fill Type", t, 1));
        s.fillColor = oldControl(box, "Fill Color", t, s.fillColor);
        s.fillAngle = oldControl(box, "Fill Angle", t, 90);
        s.fillOpacity = oldControl(box, "Fill Opacity", t, 100);
        // Whether it has a stroke: at any time, not just now.
        s.strokeWidth = oldMax(box, "Stroke Width", t, 0);
        s.strokeType = Math.round(oldControl(box, "Stroke Type", t, 1));
        s.strokeColor = oldControl(box, "Stroke Color", t, s.strokeColor);
        s.strokeAngle = oldControl(box, "Stroke Angle", t, 90);
        s.strokeOpacity = oldControl(box, "Stroke Opacity", t, 100);
        if (findControl(box, "Layout") && Math.round(oldControl(box, "Layout", t, 1)) != 1) {
            notes.push("its stack is now plain layers, left where they were");
        }
        if (s.fillType != 1 || (s.strokeType != 1 && s.strokeWidth > 0)) {
            notes.push("gradient colors are back to white and black: set them with Edit Gradient in its Contents");
        }
        if ((s.fillType != 1 && isKeyed(box, "Fill Angle")) || (s.strokeType != 1 && isKeyed(box, "Stroke Angle"))) {
            notes.push("its gradient angle animation isn't carried over: animate the gradient's Start and End Point instead");
        }

        // Locked layers can't change: unlock the box and its layers meanwhile.
        return unlocked([box].concat(directMembers(comp, box)), function () {
            convertUnlocked(comp, box, adoptOutside, s, result);
            return result;
        });
    }

    function convertUnlocked(comp, box, adoptOutside, s, result) {
        var t = comp.time, i;
        // Members: 1.x tracked them by name, 2.x laid them out with expressions.
        if (isLegacyBox(box)) {
            var adopted = adoptLegacyMembers(comp, box, adoptOutside !== false);
            result.moved = adopted.moved;
            result.left = adopted.left;
        }
        var members = directMembers(comp, box);
        for (i = 0; i < members.length; i++) freeze(comp, members[i]);

        // Old paint: the stroke layer, the Tint, the expression-driven items.
        var strokeLayer = oldStrokeLayerOf(comp, box);
        if (strokeLayer) {
            strokeLayer.locked = false;
            strokeLayer.remove();
        }
        var tint = findControl(box, "Fill Tint");
        if (tint) tint.remove();
        removeItems(box, RIG_GROUP, isOldPaint);
        rigParts(box).roundness.expression = "";
        // Keys first: painting leaves keyframed properties alone, and switches
        // a stroke on if any of its width keys draws.
        for (i = 0; i < PAINT.length; i++) ensureItem(box, RIG_GROUP, PAINT[i].name, PAINT[i].match);
        var item = function (name, match) { return vectors(box, RIG_GROUP).property(name).property(match); };
        carryKeys(box, "Corner Radius", rigParts(box).roundness);
        carryKeys(box, "Fill Color", item("Fill", "ADBE Vector Fill Color"));
        carryKeys(box, "Fill Opacity", item(s.fillType == 1 ? "Fill" : "Gradient Fill", "ADBE Vector Fill Opacity"));
        carryKeys(box, "Stroke Color", item("Stroke", "ADBE Vector Stroke Color"));
        carryKeys(box, "Stroke Width", item(s.strokeType == 1 ? "Stroke" : "Gradient Stroke", "ADBE Vector Stroke Width"));
        carryKeys(box, "Stroke Opacity", item(s.strokeType == 1 ? "Stroke" : "Gradient Stroke", "ADBE Vector Stroke Opacity"));
        paintBox(box, s);

        for (i = 0; i < OLD_CONTROLS.length; i++) {
            var effect = findControl(box, OLD_CONTROLS[i]);
            if (effect) effect.remove();
        }
        ensureControls(box, DEFAULTS, t);
        var layers = boxMembers(comp, box);
        rigBox(box, homesOf(comp, box, layers));
    }

    // Ask before converting old boxes. Returns, for each of `boxes` (by
    // position: converting removes layers, so indexes shift), null (don't
    // convert, or not old) or { adoptOutside }.
    function askConvert(comp, boxes) {
        var old = [], names = [], at = [], answers = [], i;
        for (i = 0; i < boxes.length; i++) {
            answers.push(null);
            if (isOldBox(boxes[i])) {
                old.push(boxes[i]);
                at.push(i);
                names.push(boxes[i].name);
            }
        }
        if (!old.length) return answers;
        var ok = confirm(names.join(", ") + (old.length > 1 ? " were" : " was") + " made with an older AutoBox. " +
            "Convert to AutoBox " + VERSION + "?\n\nThe layers in it lose their AutoBox expressions and stay where they are " +
            "(a stack becomes plain layers). Its fill and stroke become native shape properties in its Contents; " +
            "gradient colors go back to white and black.", false, SCRIPT_NAME);
        for (i = 0; i < old.length; i++) {
            if (!ok) continue;
            var cuts = isLegacyBox(old[i]) ? legacyCuts(comp, old[i]) : [];
            answers[at[i]] = {
                adoptOutside: !cuts.length || confirm(old[i].name + " was made with AutoBox 1.0, which left these layers " +
                    "parented to other layers:\n\n" + cuts.join("\n") + "\n\nParent them to the box so it keeps fitting them? " +
                    "(No leaves them where they are, outside the box.)", false, SCRIPT_NAME)
            };
        }
        return answers;
    }

    function reportConversions(converted, more) {
        if (!converted.length) return;
        var lines = [];
        for (var i = 0; i < converted.length; i++) {
            var c = converted[i], notes = c.notes.slice(0);
            if (c.moved.length) notes.push("now parented to it: " + c.moved.join(", "));
            if (c.left.length) notes.push("left outside it: " + c.left.join(", "));
            lines.push(c.name + (notes.length ? " (" + notes.join("; ") + ")" : ""));
        }
        alert("Converted to AutoBox " + VERSION + ":\n\n" + lines.join("\n") + (more ? "\n\n" + more : ""), SCRIPT_NAME);
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------
    function createBox(s) {
        var comp = activeComp();
        if (!comp) return;
        if (!comp.selectedLayers.length) {
            alert("Select the layers you want to put in a box, then click Create Box.", SCRIPT_NAME);
            return;
        }
        var members = pickMembers(comp.selectedLayers, null);
        if (!members.length) return;
        // Layers that share a parent (a controller null, or the box they're
        // in) keep it: the new box is parented to it instead.
        var top = topLevel(members), outer = sharedParent(top);
        if (outer && isOldBox(outer)) {
            alert(outer.name + " was made with an older AutoBox. Select it and click Apply to Box to convert it, then try again.", SCRIPT_NAME);
            return;
        }
        if (!confirmCut(linksToCut(top, outer))) return;

        app.beginUndoGroup("AutoBox: Create Box");
        try {
            var box = comp.layers.addShape();
            box.name = uniqueBoxName(comp, box);
            // The box morphs on its layers' curves; motion blur would only
            // multiply the work its expressions do.
            try { box.motionBlur = false; } catch (err) {}
            box.moveAfter(lowestLayer(members));
            fitTiming(box, members);
            var tr = box.property("ADBE Transform Group");
            tr.property("ADBE Anchor Point").setValue([0, 0]);
            // Built in the shared parent's space, so a box inside a rotated or
            // scaled parent isn't counter-rotated or rescaled.
            if (outer) box.setParentWithJump(outer);
            tr = box.property("ADBE Transform Group");
            tr.property("ADBE Position").setValue(anchorPoint(measure(comp, box, members, outer), s));
            // Inside another box: sit above it so the new box shows.
            if (outer && isBox(outer) && box.index > outer.index) box.moveBefore(outer);

            addControls(box, s, comp.time);
            buildShape(box);
            rigBox(box, homesOf(comp, box, members));
            adopt(comp, box, members);
            skipCarriers(comp, box);
            paintBox(box, s);

            deselectAll(comp);
            box.selected = true;
            checkRig(comp, box);
        } finally {
            app.endUndoGroup();
        }
    }

    // Boxes the current selection points at: selected box layers, plus the
    // boxes of any selected members.
    function selectedBoxes(comp) {
        var sel = comp.selectedLayers, out = [];
        for (var i = 0; i < sel.length; i++) {
            var box = isBox(sel[i]) ? sel[i] : ownerBox(sel[i]);
            if (box && !containsLayer(out, box)) out.push(box);
        }
        if (!out.length) alert("Select a box layer (or one of its layers) first.", SCRIPT_NAME);
        return out;
    }

    function addToBox() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, box = null, i;
        // The outermost box sits lowest in the stack, so prefer the lowest one.
        for (i = 0; i < sel.length; i++) {
            if (isBox(sel[i]) && (!box || sel[i].index > box.index)) box = sel[i];
        }
        if (!box || sel.length < 2) {
            alert("Select a box layer and the layers you want to add to it.", SCRIPT_NAME);
            return;
        }
        if (box.locked) {
            alert(box.name + " is locked.", SCRIPT_NAME);
            return;
        }
        var added = pickMembers(sel, box);
        if (!added.length) return;
        if (!confirmCut(linksToCut(topLevel(added), box))) return;
        var answers = askConvert(comp, [box]), oldBox = isOldBox(box);
        if (oldBox && !answers[0]) return;

        app.beginUndoGroup("AutoBox: Add to Box");
        try {
            var converted = answers[0] ? convertBox(comp, box, answers[0].adoptOutside) : null;
            var old = homeOf(rigParts(box).size.expression) || [], home = [];
            adopt(comp, box, added);
            var members = directMembers(comp, box);
            var lowest = lowestLayer(members.concat(added));
            if (lowest.index > box.index) box.moveAfter(lowest);
            // Homes once the stack is settled; a layer added again gets a new one.
            for (i = 0; i < old.length; i++) {
                var again = false;
                for (var k = 0; k < added.length; k++) {
                    if (old[i].length > 5 && old[i][5] === added[k].name) again = true;
                }
                if (!again) home.push(old[i]);
            }
            home = home.concat(homesOf(comp, box, added));
            fitTiming(box, members.concat(added), true);
            rigBox(box, home);
            skipCarriers(comp, box);
            checkRig(comp, box);
            if (converted) reportConversions([converted]);
        } finally {
            app.endUndoGroup();
        }
    }

    function removeFromBox() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, picked = [], owners = [], locked = [], i, j;
        for (i = 0; i < sel.length; i++) {
            if (isOldStrokeLayer(sel[i])) continue;
            var owner = ownerBox(sel[i]);
            if (!owner && !hasRigExpression(sel[i])) continue;
            if (sel[i].locked) {
                locked.push(sel[i].name);
                continue;
            }
            picked.push(sel[i]);
            owners.push(owner);
        }
        if (!picked.length) {
            alert(locked.length ? "Skipped (locked): " + locked.join(", ") : "Select the layers you want to take out of their box.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: Remove from Box");
        try {
            // Layers of an old (2.x) stack carry layout expressions: bake them
            // all first, since unparenting one changes the layout of the others.
            for (i = 0; i < picked.length; i++) releaseMember(comp, picked[i]);
            // A 1.x member can carry a stale AutoBox expression while parented to
            // something else (a controller null): keep that link. Out of its
            // box, a layer keeps whatever the box was in (an outer box, a
            // controller null), and stays where it is.
            var dest = [];
            for (i = 0; i < picked.length; i++) dest.push(owners[i] ? owners[i].parent : null);
            for (i = 0; i < picked.length; i++) {
                if (!owners[i]) continue;
                // Leaving with a picked parent (a controller null): it stays on it.
                var carried = false;
                for (var up = picked[i].parent; up && !sameLayer(up, owners[i]); up = up.parent) {
                    if (containsLayer(picked, up)) carried = true;
                }
                if (carried) continue;
                var riders = [];
                for (j = 1; j <= comp.numLayers; j++) {
                    if (isAncestor(picked[i], comp.layer(j))) riders.push(comp.layer(j));
                }
                picked[i].parent = dest[i];
                // Its box can't be its matte any more.
                for (j = 0; j < riders.length; j++) unmatte(riders[j], owners[i]);
            }
            if (locked.length) alert("Skipped (locked): " + locked.join(", "), SCRIPT_NAME);
        } finally {
            app.endUndoGroup();
        }
    }

    // Take `box` off as layer's track matte.
    function unmatte(layer, box) {
        if (layer.locked || typeof layer.setTrackMatte !== "function" || !sameLayer(layer.trackMatteLayer, box)) return;
        layer.setTrackMatte(null, TrackMatteType.NO_TRACK_MATTE);
    }

    // Leave out locked boxes, saying so.
    function skipLocked(boxes) {
        var out = [], names = [];
        for (var i = 0; i < boxes.length; i++) {
            if (boxes[i].locked) names.push(boxes[i].name);
            else out.push(boxes[i]);
        }
        if (names.length) alert("Skipped (locked): " + names.join(", ") + "\n\nUnlock a box to change it.", SCRIPT_NAME);
        return out;
    }

    // Push the panel's settings onto the selected boxes. Animated controls
    // and properties are left alone. Old boxes are only converted the first
    // time, so their own look survives.
    function applySettings(s) {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), converted = [], old = [], i;
        if (!boxes.length) return;
        boxes = skipLocked(boxes);
        if (!boxes.length) return;
        var answers = askConvert(comp, boxes);
        for (i = 0; i < boxes.length; i++) old.push(isOldBox(boxes[i]));
        app.beginUndoGroup("AutoBox: Apply Settings");
        try {
            for (i = 0; i < boxes.length; i++) {
                if (old[i]) {
                    if (answers[i]) converted.push(convertBox(comp, boxes[i], answers[i].adoptOutside));
                    continue;
                }
                setControls(boxes[i], s, comp.time, true);
                rigBox(boxes[i]);
                skipCarriers(comp, boxes[i]);
                paintBox(boxes[i], s);
                checkRig(comp, boxes[i]);
            }
            reportConversions(converted, "Click Apply to Box again to apply the panel's settings to them.");
        } finally {
            app.endUndoGroup();
        }
    }

    function selectMembers() {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), i, j;
        if (!boxes.length) return;
        deselectAll(comp);
        for (i = 0; i < boxes.length; i++) {
            var members = boxMembers(comp, boxes[i]);
            for (j = 0; j < members.length; j++) members[j].selected = true;
        }
    }

    // Use each selected box as the track matte (alpha) of its layers, and
    // keep the box itself visible as their background. If every layer already
    // uses the box, take the mattes off instead.
    function matteBoxes() {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), plans = [], off = true, locked = [], i, j;
        if (!boxes.length) return;
        boxes = skipLocked(boxes);
        if (!boxes.length) return;
        for (i = 0; i < boxes.length; i++) {
            if (isOldBox(boxes[i])) {
                alert(boxes[i].name + " was made with an older AutoBox. Click Apply to Box to convert it first.", SCRIPT_NAME);
                return;
            }
            var members = boxMembers(comp, boxes[i]), layers = [], all = true;
            for (j = 0; j < members.length; j++) {
                var m = members[j];
                if (!(m instanceof AVLayer) || !m.hasVideo || m.nullLayer || m.adjustmentLayer || m.guideLayer) continue;
                if (m.locked) {
                    locked.push(m.name);
                    continue;
                }
                if (typeof members[j].setTrackMatte !== "function") {
                    alert("Using any layer as a track matte needs After Effects 2023 (23.0) or newer.\n\n" +
                        "In older versions, duplicate the box, put the copy right above a layer and pick Alpha Matte " +
                        "in that layer's Track Matte menu.", SCRIPT_NAME);
                    return;
                }
                layers.push(members[j]);
                if (!sameLayer(members[j].trackMatteLayer, boxes[i])) all = false;
            }
            if (layers.length) plans.push({ box: boxes[i], layers: layers });
            if (layers.length && !all) off = false;
        }
        if (!plans.length) {
            alert("There are no layers in the selected box to matte.", SCRIPT_NAME);
            return;
        }
        // One click, one direction: off only when every box is already the
        // matte of all its layers.
        for (i = 0; i < plans.length; i++) plans[i].off = off;
        var other = [];
        for (i = 0; i < plans.length; i++) {
            for (j = 0; j < plans[i].layers.length && !plans[i].off; j++) {
                var current = plans[i].layers[j].trackMatteLayer;
                if (current && !sameLayer(current, plans[i].box)) other.push(plans[i].layers[j].name + " (uses " + current.name + ")");
            }
        }
        if (other.length && !confirm("These layers already use another layer as their track matte:\n\n" + other.join("\n") +
                "\n\nUse the box instead?", false, SCRIPT_NAME)) return;

        var notes = [];
        app.beginUndoGroup("AutoBox: Matte");
        try {
            for (i = 0; i < plans.length; i++) {
                var p = plans[i];
                for (j = 0; j < p.layers.length; j++) {
                    if (!p.off) p.layers[j].setTrackMatte(p.box, TrackMatteType.ALPHA);
                }
                // Off: also any layer that left the box but still uses it.
                if (p.off) {
                    for (j = 1; j <= comp.numLayers; j++) unmatte(comp.layer(j), p.box);
                }
                // Becoming a matte switches the box's video off: it's also the background.
                p.box.enabled = true;
                if (p.off) continue;
                // A matte only works while it's there: cover all its layers.
                fitTiming(p.box, p.layers, true);
                notes = notes.concat(matteNotes(p.box));
            }
        } finally {
            app.endUndoGroup();
        }
        if (locked.length) alert("Skipped (locked): " + locked.join(", ") + "\n\nUnlock a layer to change its matte.", SCRIPT_NAME);
        if (notes.length) {
            alert("Its layers now show only inside the box. Note that the box's own transparency and effects " +
                "shape the matte too:\n\n" + notes.join("\n") + "\n\nFor a see-through or shadowed box, duplicate it, " +
                "keep the copy fully opaque with no effects, and use the copy as the matte instead.", SCRIPT_NAME);
        }
    }

    // What about a box would also fade or shape its layers as their matte.
    function matteNotes(box) {
        var out = [], tr = box.property("ADBE Transform Group").property("ADBE Opacity"), i;
        if (tr.numKeys > 0 || tr.value < 100) out.push(box.name + ": its Opacity");
        var fill = vectors(box, RIG_GROUP).property("Fill"), gradient = vectors(box, RIG_GROUP).property("Gradient Fill");
        var see = function (item, what) {
            var o = item.property("ADBE Vector Fill Opacity");
            if (o.numKeys > 0 || o.value < 100) out.push(box.name + ": its " + what);
        };
        if (fill && fill.enabled) see(fill, "Fill Opacity");
        else if (gradient && gradient.enabled) {
            see(gradient, "Gradient Fill Opacity");
            out.push(box.name + ": its gradient, if any of its color stops are see-through");
        } else {
            out.push(box.name + ": it has no fill, so its layers only show under its stroke");
        }
        var fx = box.property("ADBE Effect Parade"), names = {};
        for (i = 0; i < CONTROLS.length; i++) names[CONTROLS[i].name] = true;
        for (i = 1; i <= fx.numProperties; i++) {
            if (!names[fx.property(i).name]) out.push(box.name + ": the " + fx.property(i).name + " effect");
        }
        return out;
    }

    // The In Box menu: Auto lets AutoBox decide, In / Out override it (key
    // them to say when), Skip leaves the layer out but not its children.
    function addInBoxMenu(layer, value) {
        var fx = layer.property("ADBE Effect Parade");
        var effect = addDropdown(fx, IN_BOX_ITEMS);
        effect.name = IN_BOX;
        if (value != 1) fx.property(IN_BOX).property(1).setValue(value);
    }

    // Nulls and adjustment layers in a box only carry their children.
    function skipCarriers(comp, box) {
        var members = boxMembers(comp, box);
        for (var i = 0; i < members.length; i++) {
            var layer = members[i];
            if ((layer.nullLayer || layer.adjustmentLayer || layer.guideLayer) && !layer.locked && !findControl(layer, IN_BOX)) {
                try { addInBoxMenu(layer, 4); } catch (err) {}
            }
        }
    }

    function addInBoxToggles() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, picked = [], skipped = [], i;
        for (i = 0; i < sel.length; i++) {
            var layer = sel[i], box = ownerBox(layer);
            if (!box || isOldStrokeLayer(layer)) continue;
            if (isOldBox(box)) skipped.push(layer.name + " — its box was made with an older AutoBox (Apply to Box converts it)");
            else if (isBox(layer)) skipped.push(layer.name + " — it's a box: add In Box to the layers in it");
            else if (findControl(layer, IN_BOX)) skipped.push(layer.name + " — it already has In Box");
            else if (layer.locked) skipped.push(layer.name + " — layer is locked");
            else picked.push(layer);
        }
        if (!picked.length) {
            alert(skipped.length ? "Skipped:\n" + skipped.join("\n") : "Select layers inside a box first.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: In Box");
        try {
            for (i = 0; i < picked.length; i++) addInBoxMenu(picked[i], 1);
            if (skipped.length) alert("Skipped:\n" + skipped.join("\n"), SCRIPT_NAME);
        } finally {
            app.endUndoGroup();
        }
    }

    function releaseBoxes() {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), i, j, k;
        if (!boxes.length) return;
        boxes = skipLocked(boxes);
        if (!boxes.length) return;
        if (!confirm("Release " + boxes.length + " box(es)?\n\nThe box's size is baked into plain values/keyframes and " +
                "stops following its layers. Its fill and stroke stay.", false, SCRIPT_NAME)) return;

        for (i = 0; i < boxes.length; i++) {
            var size = rigParts(boxes[i]).size;
            try { size.valueAtTime(comp.time, false); } catch (err) {}
            if (size.expression && size.expressionError) {
                alert(boxes[i].name + "'s expression has an error, so Release would change its shape:\n\n" + size.expressionError +
                    "\n\nFix it (Apply to Box rebuilds it), then release.", SCRIPT_NAME);
                return;
            }
        }

        app.beginUndoGroup("AutoBox: Release");
        try {
            // Bake every box before removing any controls: a nested box's size
            // depends on its outer box and the other way round.
            var old = [], toggles = [];
            for (i = 0; i < boxes.length; i++) {
                var box = boxes[i], parts = rigParts(box), range = layerTimeRange(comp, box);
                old.push(isOldBox(box));
                if (!old[i]) toggles = toggles.concat(boxMembers(comp, box));
                if (old[i]) {
                    // 2.x laid out its layers with expressions, 1.x also tracked
                    // them by name: bake those in place.
                    var members = directMembers(comp, box), legacy = legacyMembers(comp, box);
                    for (j = 0; j < legacy.length; j++) {
                        if (!containsLayer(members, legacy[j])) members.push(legacy[j]);
                    }
                    unlocked(members, function () {
                        for (var n = 0; n < members.length; n++) releaseMember(comp, members[n]);
                    });
                    bakeProperty(comp, parts.roundness, range);
                }
                bakeProperty(comp, parts.size, range);
                bakeProperty(comp, parts.position, range);
                if (!old[i]) {
                    for (j = 0; j < PAINT.length; j++) {
                        var item = vectors(box, RIG_GROUP).property(PAINT[j].name);
                        if (!item || item.matchName.indexOf("G-") < 0) continue;
                        bakeProperty(comp, item.property("ADBE Vector Grad Start Pt"), range);
                        item = vectors(box, RIG_GROUP).property(PAINT[j].name);
                        bakeProperty(comp, item.property("ADBE Vector Grad End Pt"), range);
                    }
                }
            }
            for (i = 0; i < boxes.length; i++) {
                var names = [];
                if (old[i]) names = OLD_LAYOUT_CONTROLS;
                else for (j = 0; j < CONTROLS.length; j++) names.push(CONTROLS[j].name);
                for (j = names.length - 1; j >= 0; j--) {
                    var effect = findControl(boxes[i], names[j]);
                    if (effect) effect.remove();
                }
            }
            for (k = 0; k < toggles.length; k++) {
                var toggle = findControl(toggles[k], IN_BOX);
                if (toggle && !toggles[k].locked) toggle.remove();
            }
        } finally {
            app.endUndoGroup();
        }
    }

    function showHelp() {
        alert([
            SCRIPT_NAME + " " + VERSION + " — Braised Tools",
            "",
            "CREATE BOX — select layers, then click. A shape layer is added behind them, sized to",
            "fit with padding and rounded corners, and the layers are parented to it. Moving,",
            "scaling or rotating the box moves the whole group. The layers get no expressions:",
            "animate them as usual.",
            "",
            "SMART ANIMATE — the box follows the layers' keyframes, not every frame. A move that",
            "brings a layer into view (from clear of where it ends up, or fading or scaling in)",
            "brings it in; one that takes it clear away (or fades or scales it out, or erases it)",
            "takes it out, and so does its out point; smaller moves reposition it. The box morphs",
            "to fit the layers that are in, each on its own curve, and keeps a leaving layer's",
            "space until the next one comes in. Layers without keyframes come in at their in",
            "point over Morph Time. Freeze (Effect Controls) holds the box. IN BOX adds a menu",
            "to the selected layers: keyframe In / Out to say yourself when a layer counts.",
            "MATTE uses the box as its layers' track matte (After Effects 2023+).",
            "",
            "LOOK — fill, stroke, gradients and corner roundness are the box's own shape",
            "properties (its Contents). Gradients stretch with the box: their Start/End Point are",
            "percentages of it. Padding, size and animation settings are in Effect Controls.",
            "Panel values are the defaults for new boxes; Apply to Box pushes them onto the",
            "selected boxes (animated properties are left alone).",
            "",
            "ADD TO BOX — select a box and other layers. REMOVE — select layers in a box.",
            "RELEASE — bakes the box's size to plain keyframes and removes the rig.",
            "SELECT MEMBERS — selects every layer in the selected box."
        ].join("\n"), SCRIPT_NAME);
    }
    // ------------------------------------------------------------------
    // UI (ScriptUI panel)
    // ------------------------------------------------------------------
    function buildUI(host) {
        var s = loadSettings();
        var win = (host instanceof Panel) ? host : new Window("palette", SCRIPT_NAME, undefined, { resizeable: true });
        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 6;
        win.margins = 8;

        function persist() {
            saveSettings(s);
        }

        function row(parent, label) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            g.alignment = ["fill", "top"];
            g.spacing = 4;
            if (label !== undefined) g.add("statictext", undefined, label).preferredSize.width = 64;
            return g;
        }

        function text(parent, label) {
            return parent.add("statictext", undefined, label);
        }

        function clampValue(v, min, max) {
            if (min !== undefined && v < min) v = min;
            if (max !== undefined && v > max) v = max;
            return v;
        }

        // A number field: typed values are clamped to [min, max].
        function number(parent, key, tip, chars, min, max) {
            var e = parent.add("edittext", undefined, String(s[key]));
            e.characters = chars || 4;
            e.helpTip = tip;
            e.onChange = function () {
                var v = parseFloat(this.text);
                if (isNaN(v)) {
                    this.text = String(s[key]);
                    return;
                }
                s[key] = clampValue(v, min, max);
                this.text = String(s[key]);
                if (this.slider) this.slider.value = clampValue(s[key], this.slider.minvalue, this.slider.maxvalue);
                persist();
            };
            return e;
        }

        // Slider + number field, like an After Effects slider control.
        // The slider covers [lo, hi]; typed values may go past it within [min, max].
        function slider(parent, label, key, lo, hi, tip, min, max, decimals) {
            var g = row(parent, label);
            var sl = g.add("slider", undefined, clampValue(s[key], lo, hi), lo, hi);
            sl.alignment = ["fill", "center"];
            sl.preferredSize.width = 110;
            sl.helpTip = tip;
            var e = number(g, key, tip, 4, min, max);
            e.slider = sl;
            var step = Math.pow(10, decimals || 0);
            sl.onChanging = sl.onChange = function () {
                s[key] = Math.round(this.value * step) / step;
                e.text = String(s[key]);
                persist();
            };
            return g;
        }

        function dropdown(parent, key, items, tip) {
            var d = parent.add("dropdownlist", undefined, items);
            d.selection = Math.max(0, Math.min(items.length - 1, Math.round(s[key]) - 1));
            d.helpTip = tip;
            d.onChange = function () {
                if (this.selection) {
                    s[key] = this.selection.index + 1;
                    persist();
                }
            };
            return d;
        }

        function swatch(parent, key, tip) {
            var b = parent.add("button", undefined, "");
            b.preferredSize = [34, 20];
            b.helpTip = tip;
            b.onDraw = function () {
                var g = this.graphics, c = s[key];
                g.rectPath(0, 0, this.size[0], this.size[1]);
                g.fillPath(g.newBrush(g.BrushType.SOLID_COLOR, [c[0], c[1], c[2], 1]));
                g.rectPath(0, 0, this.size[0], this.size[1]);
                g.strokePath(g.newPen(g.PenType.SOLID_COLOR, [0.5, 0.5, 0.5, 1], 1));
            };
            b.onClick = function () {
                var c = s[key];
                var hex = (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
                var picked = $.colorPicker(hex);
                if (picked < 0) return;
                s[key] = [((picked >> 16) & 255) / 255, ((picked >> 8) & 255) / 255, (picked & 255) / 255];
                persist();
                this.hide();
                this.show();
            };
            return b;
        }

        function run(fn) {
            try {
                fn(s);
            } catch (err) {
                alert("Something went wrong:\n" + err.toString() + (err.line ? " (line " + err.line + ")" : ""), SCRIPT_NAME);
            }
        }

        function button(parent, label, fn, tip) {
            var b = parent.add("button", undefined, label);
            b.alignment = ["fill", "center"];
            b.helpTip = tip;
            b.onClick = function () {
                run(fn);
            };
            return b;
        }

        function buttonRow() {
            var g = win.add("group");
            g.orientation = "row";
            g.alignChildren = ["fill", "center"];
            g.spacing = 4;
            return g;
        }

        function tab(tabs, title) {
            var t = tabs.add("tab", undefined, title);
            t.orientation = "column";
            t.alignChildren = ["fill", "top"];
            t.spacing = 4;
            t.margins = [8, 10, 8, 8];
            return t;
        }

        // Fill / Stroke tab body: type, color, angle, opacity.
        function paintTab(t, prefix, name) {
            var r = row(t, "Type");
            dropdown(r, prefix + "Type", PAINT_TYPES, name + ": a solid color or a gradient that stretches with the box");
            r = row(t, "Color");
            swatch(r, prefix + "Color", name + " color. Gradient colors are set with Edit Gradient in the box's Contents");
            slider(t, "Angle", prefix + "Angle", 0, 360, "Linear gradient direction in degrees (0 = up, 90 = right)");
            slider(t, "Opacity", prefix + "Opacity", 0, 100, name + " opacity (%)", 0, 100);
        }

        function checkbox(parent, label, key, tip) {
            var c = parent.add("checkbox", undefined, label);
            c.value = s[key] > 0;
            c.helpTip = tip;
            c.onClick = function () {
                s[key] = this.value ? 1 : 0;
                persist();
            };
            return c;
        }

        var tabs = win.add("tabbedpanel");
        tabs.alignChildren = ["fill", "top"];

        var t = tab(tabs, "Box");
        slider(t, "Padding", "padding", 0, 200, "Space between the layers and the edge of the box on every side (px)");
        slider(t, "Radius", "radius", 0, 200, "Corner radius (px): the box's Roundness", 0);
        var r = row(t, "Extra");
        text(r, "T");
        number(r, "extraTop", "Extra padding on top (px), added to Padding", 3);
        text(r, "R");
        number(r, "extraRight", "Extra padding on the right (px), added to Padding", 3);
        text(r, "B");
        number(r, "extraBottom", "Extra padding at the bottom (px), added to Padding", 3);
        text(r, "L");
        number(r, "extraLeft", "Extra padding on the left (px), added to Padding", 3);
        r = row(t, "Min size");
        text(r, "W");
        number(r, "minWidth", "Minimum box width (px), 0 = fit contents", 4, 0);
        text(r, "H");
        number(r, "minHeight", "Minimum box height (px), 0 = fit contents", 4, 0);
        r = row(t, "Anchor");
        dropdown(r, "anchor", ANCHORS, "The point of the box that stays put while it grows, and that it grows from");
        checkbox(t, "Ignore hidden layers", "ignoreHidden", "Layers whose video switch is off don't count");

        t = tab(tabs, "Animate");
        checkbox(t, "Smart Animate", "smartAnimate",
            "The box morphs to fit the layers coming in, on their keyframe curves, and holds while layers leave. " +
            "Off: it follows the layers every frame");
        r = row(t, "Grow from");
        dropdown(r, "growFrom", GROW_FROM,
            "Where the box grows from when the first layer comes in: the side it comes from (Motion), Box Anchor, or no growing (Snap)");
        r = row(t, "When empty");
        dropdown(r, "whenEmpty", WHEN_EMPTY, "When the last layer leaves: keep the box (Hold) or shrink it away with that layer (Collapse)");
        slider(t, "Morph", "morphTime", 0, 2, "Morph Time (s): how long the box takes to fit a layer that comes in without keyframes", 0, 60, 2);
        r = row(t, "Ease");
        dropdown(r, "morphEase", EASES, "Morph Ease: the easing of those morphs");

        t = tab(tabs, "Fill");
        paintTab(t, "fill", "Fill");

        t = tab(tabs, "Stroke");
        slider(t, "Width", "strokeWidth", 0, 50, "Stroke width (px), 0 = no stroke", 0);
        paintTab(t, "stroke", "Stroke");
        tabs.selection = 0;

        var create = win.add("button", undefined, "Create Box");
        create.helpTip = "Put a box behind the selected layers";
        create.onClick = function () {
            run(createBox);
        };

        var g = buttonRow();
        button(g, "Add to Box", addToBox, "Select a box and other layers to add them to it");
        button(g, "Remove", removeFromBox, "Take the selected layers out of their box");
        g = buttonRow();
        button(g, "Apply to Box", applySettings, "Push the panel's settings to the selected box(es)");
        button(g, "Select Members", selectMembers, "Select every layer in the selected box(es)");
        g = buttonRow();
        button(g, "Matte", matteBoxes, "Use the box as the track matte of its layers (click again to remove). After Effects 2023+");
        button(g, "In Box", addInBoxToggles, "Add an In Box menu to the selected layers: Auto, or keyframe In / Out to say when the box fits them");
        g = buttonRow();
        button(g, "Release", releaseBoxes, "Bake the box's size and remove the AutoBox rig from the selected box(es)");
        var help = g.add("button", undefined, "?");
        help.preferredSize.width = 28;
        help.helpTip = "How AutoBox works";
        help.onClick = showHelp;

        var footer = win.add("statictext", undefined, SCRIPT_NAME + " " + VERSION + " · Braised Tools");
        footer.alignment = ["center", "top"];

        win.onResizing = win.onResize = function () {
            this.layout.resize();
        };
        win.layout.layout(true);
        if (win instanceof Window) {
            win.center();
            win.show();
        }
        return win;
    }

    // ------------------------------------------------------------------
    // CEP panel (AutoBox.zxp) entry point
    // ------------------------------------------------------------------
    var HOST_ACTIONS = {
        create: createBox,
        add: addToBox,
        remove: removeFromBox,
        apply: applySettings,
        select: selectMembers,
        matte: matteBoxes,
        inbox: addInBoxToggles,
        release: releaseBoxes,
        help: showHelp
    };

    // Panel settings arrive as a plain object literal; fill gaps from DEFAULTS.
    function normalizeSettings(input) {
        var s = copySettings(DEFAULTS);
        if (!input) return s;
        for (var k in DEFAULTS) {
            if (input[k] === undefined || input[k] === null) continue;
            s[k] = parseSetting((input[k] instanceof Array) ? input[k].join(",") : input[k], DEFAULTS[k]);
        }
        return s;
    }

    function hostRun(action, input) {
        if (!HOST_ACTIONS.hasOwnProperty(action)) return "Unknown action: " + action;
        try {
            HOST_ACTIONS[action](normalizeSettings(input));
            return "ok";
        } catch (err) {
            return "Something went wrong: " + err.toString() + (err.line ? " (line " + err.line + ")" : "");
        }
    }

    // The CEP panel sets AUTOBOX_CEP while it loads this file with $.evalFile.
    if (typeof AUTOBOX_CEP !== "undefined" && AUTOBOX_CEP) {
        $.global.AutoBoxHost = { version: VERSION, run: hostRun };
        return;
    }

    // Test hook: the Node test suite loads this file with AUTOBOX_TEST set.
    if (typeof AUTOBOX_TEST !== "undefined") {
        AUTOBOX_TEST.api = {
            VERSION: VERSION,
            buildExpression: buildExpression,
            buildSwitchProbe: buildSwitchProbe,
            homeOf: homeOf,
            gradientPointExpression: gradientPointExpression,
            gradientPoints: gradientPoints,
            CONTROLS: CONTROLS,
            DEFAULTS: DEFAULTS,
            createBox: createBox,
            addToBox: addToBox,
            removeFromBox: removeFromBox,
            applySettings: applySettings,
            selectMembers: selectMembers,
            matteBoxes: matteBoxes,
            addInBoxToggles: addInBoxToggles,
            releaseBoxes: releaseBoxes,
            hostRun: hostRun,
            buildUI: buildUI
        };
        return;
    }

    buildUI(thisObj);
})(this);
