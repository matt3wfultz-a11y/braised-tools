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
    // The per-layer override checkbox (an effect on a boxed layer).
    var IN_BOX = "In Box";
    // AutoBox 2.x drew the stroke on a layer of its own, with this group.
    var OLD_STROKE_GROUP = "AutoBox Stroke";

    var ANCHORS = ["Top Left", "Top", "Top Right", "Left", "Center", "Right", "Bottom Left", "Bottom", "Bottom Right"];
    var EASES = ["Linear", "Ease In", "Ease Out", "Ease In Out"];
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
        'var AB_EPS = 1e-6;',
        'function ab_ctl(n, d) { try { return AB_BOX.effect(n)(1).value; } catch (err) { return d; } }',
        'function ab_ctlProp(n) { try { return AB_BOX.effect(n)(1); } catch (err) { return null; } }',
        'var AB_ANCHOR = Math.min(8, Math.max(0, Math.round(ab_ctl("Box Anchor", 1)) - 1));',
        'var AB_PAD = ab_ctl("Padding", 0);',
        'var AB_PT = AB_PAD + ab_ctl("Extra Top", 0);',
        'var AB_PR = AB_PAD + ab_ctl("Extra Right", 0);',
        'var AB_PB = AB_PAD + ab_ctl("Extra Bottom", 0);',
        'var AB_PL = AB_PAD + ab_ctl("Extra Left", 0);',
        'var AB_MINW = ab_ctl("Min Width", 0);',
        'var AB_MINH = ab_ctl("Min Height", 0);',
        'var AB_SKIP = ab_ctl("Ignore Hidden", 1) > 0;',
        'var AB_SMART = ab_ctl("Smart Animate", 1) > 0;',
        'var AB_MT = Math.max(0, ab_ctl("Morph Time", 0.4));',
        'var AB_EASE = Math.round(ab_ctl("Morph Ease", 4));',
        'var AB_IN = AB_BOX.inPoint;',
        'function ab_isText(L) { try { return L.text.sourceText !== undefined; } catch (err) { return false; } }',
        'function ab_isBox(L) { try { L.content("AutoBox"); return true; } catch (err) { return false; } }',
        // L and its parents below the box, or null when L isn't in this box (or sits
        // in a box nested in it, which handles it).
        'function ab_chain(L) {',
        '  var chain = [L], cur = L;',
        '  for (var g = 0; g < 50 && cur.hasParent; g++) {',
        '    var p = cur.parent;',
        '    if (p.index == AB_BOX.index) return chain;',
        '    if (ab_isBox(p)) return null;',
        '    chain.push(p);',
        '    cur = p;',
        '  }',
        '  return null;',
        '}',
        'function ab_members() {',
        '  var out = [], n = thisComp.numLayers, bi = AB_BOX.index;',
        '  for (var i = 1; i <= n; i++) {',
        '    if (i == bi) continue;',
        '    try {',
        '      var L = thisComp.layer(i);',
        '      if (!L.hasParent || L.hasVideo !== true) continue;',
        '      if (AB_SKIP && !L.enabled) continue;',
        '      var chain = ab_chain(L);',
        '      if (!chain) continue;',
        '      var text = ab_isText(L), a = L.inPoint, b = L.outPoint;',
        // in/out: a time-reversed layer has its in point after its out point.
        '      var m = { L: L, chain: chain, text: text, box: !text && ab_isBox(L), cache: {}, tm: {}, lin: Math.min(a, b), lout: Math.max(a, b) };',
        '      ab_geom(m, AB_T, AB_T);',
        '      out.push(m);',
        '    } catch (err) {}',
        '  }',
        '  return out;',
        '}',
        // The transforms that place a member in the box at time T: its own and its
        // parents' below the box (never the box's own, so nested boxes can't cycle).
        'function ab_matrices(m, T) {',
        '  var key = "t" + T;',
        '  if (m.tm[key]) return m.tm[key];',
        '  var list = [];',
        '  for (var j = 0; j < m.chain.length; j++) {',
        '    var tr = m.chain[j].transform, r = tr.rotation.valueAtTime(T) * Math.PI / 180;',
        '    list.push({ a: tr.anchorPoint.valueAtTime(T), s: tr.scale.valueAtTime(T), p: tr.position.valueAtTime(T), c: Math.cos(r), sn: Math.sin(r) });',
        '  }',
        '  m.tm[key] = list;',
        '  return list;',
        '}',
        'function ab_toBox(list, x, y) {',
        '  for (var j = 0; j < list.length; j++) {',
        '    var q = list[j], dx = (x - q.a[0]) * q.s[0] / 100, dy = (y - q.a[1]) * q.s[1] / 100;',
        '    x = q.p[0] + dx * q.c - dy * q.sn;',
        '    y = q.p[1] + dx * q.sn + dy * q.c;',
        '  }',
        '  return [x, y];',
        '}',
        // sourceRectAtTime reads its time as the layer's own time: convert.
        'function ab_rect(m, t) {',
        '  var lt = t;',
        '  try { lt = m.L.sourceTime(t); } catch (err) { lt = t - m.L.startTime; }',
        '  return m.L.sourceRectAtTime(lt, !m.text);',
        '}',
        // Bounds of a member in box space: placed where it is at T; a nested box's
        // own (animated) size is read live at `now`.
        'function ab_geom(m, T, now) {',
        '  var rt = m.box ? now : T, key = T + "@" + rt;',
        '  if (m.cache[key]) return m.cache[key];',
        '  var sr = ab_rect(m, rt), mx = ab_matrices(m, T);',
        '  var xs = [sr.left, sr.left + sr.width], ys = [sr.top, sr.top + sr.height];',
        '  var g = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };',
        '  for (var k = 0; k < 4; k++) {',
        '    var q = ab_toBox(mx, xs[k % 2], ys[Math.floor(k / 2)]);',
        '    g.l = Math.min(g.l, q[0]); g.t = Math.min(g.t, q[1]); g.r = Math.max(g.r, q[0]); g.b = Math.max(g.b, q[1]);',
        '  }',
        '  m.cache[key] = g;',
        '  return g;',
        '}',
        // ---- moves: when a member's keyframes move it
        'function ab_d2(a, b) {',
        '  if (typeof a == "number") return (a - b) * (a - b);',
        '  var d = 0;',
        '  for (var i = 0; i < a.length; i++) d += (a[i] - b[i]) * (a[i] - b[i]);',
        '  return d;',
        '}',
        // Changing keyframe segments of P, as [start, end, P] (a hold key's jump is
        // instantaneous: start == end and no curve).
        'function ab_segs(P, pri, out) {',
        '  var n = P.numKeys;',
        '  if (n < 2) return;',
        '  var a = P.key(1);',
        '  for (var i = 2; i <= n; i++) {',
        '    var b = P.key(i);',
        '    if (ab_d2(a.value, b.value) > AB_EPS) {',
        '      var s = a.time, e = b.time;',
        '      var late = P.valueAtTime(Math.max(s, e - AB_FD / 2)), mid = P.valueAtTime((s + e) / 2);',
        '      if (ab_d2(mid, a.value) < AB_EPS && ab_d2(late, a.value) < AB_EPS) out.push({ s: e, e: e, P: null, pri: pri });',
        '      else out.push({ s: s, e: e, P: P, pri: pri });',
        '    }',
        '    a = b;',
        '  }',
        '}',
        // Keyframed properties that move a member: its own transform and its
        // parents' (below the box), its opacity, its Source Text.
        'function ab_moves(m) {',
        '  var segs = [], j, i;',
        '  for (j = 0; j < m.chain.length; j++) {',
        '    var tr = m.chain[j].transform, own = j == 0 ? 0 : 1;',
        '    var props = [[tr.position, own], [tr.scale, 2 + own], [tr.rotation, 4], [tr.anchorPoint, 5]];',
        '    try { props.push([tr.xPosition, own], [tr.yPosition, own]); } catch (err) {}',
        '    for (i = 0; i < props.length; i++) {',
        '      try { ab_segs(props[i][0], props[i][1], segs); } catch (err2) {}',
        '    }',
        '  }',
        '  try { ab_segs(m.L.transform.opacity, 6, segs); } catch (err3) {}',
        '  if (m.text) {',
        '    try {',
        '      var st = m.L.text.sourceText;',
        '      for (i = 2; i <= st.numKeys; i++) segs.push({ s: st.key(i).time, e: st.key(i).time, P: null, pri: 9, txt: true });',
        '    } catch (err4) {}',
        // Text animators: their Range Selectors' Start / End / Offset.
        '    try {',
        '      var A = m.L("ADBE Text Properties")("ADBE Text Animators");',
        '      for (i = 1; i <= A.numProperties; i++) {',
        '        var S = A(i)("ADBE Text Selectors");',
        '        for (j = 1; j <= S.numProperties; j++) {',
        '          var names = ["ADBE Text Percent Start", "ADBE Text Percent End", "ADBE Text Percent Offset"];',
        '          for (var n = 0; n < names.length; n++) {',
        '            try { ab_segs(S(j)(names[n]), 7, segs); } catch (err5) {}',
        '          }',
        '        }',
        '      }',
        '    } catch (err6) {}',
        '  }',
        '  segs.sort(function (x, y) { return x.s - y.s || x.e - y.e; });',
        '  var moves = [], cur = null;',
        '  for (i = 0; i < segs.length; i++) {',
        '    var g = segs[i];',
        '    if (cur && g.s <= cur.e + AB_FD / 2) {',
        '      if (g.e > cur.e) cur.e = g.e;',
        '      cur.segs.push(g);',
        '      cur.txt = cur.txt && !!g.txt;',
        '    } else {',
        // txt: only Source Text changes (new words, not a way in or out).
        '      cur = { s: g.s, e: g.e, segs: [g], txt: !!g.txt };',
        '      moves.push(cur);',
        '    }',
        '  }',
        '  for (i = 0; i < moves.length; i++) ab_driver(moves[i]);',
        '  return moves;',
        '}',
        // The property whose curve the box borrows: the highest-priority one that
        // changes over the whole move.
        'function ab_driver(mv) {',
        '  mv.d = null;',
        '  if (mv.e - mv.s < AB_FD / 2) return;',
        '  var best = null;',
        '  for (var i = 0; i < mv.segs.length; i++) {',
        '    var g = mv.segs[i];',
        '    if (!g.P || (best && best.pri <= g.pri)) continue;',
        '    var a = g.P.valueAtTime(mv.s), b = g.P.valueAtTime(mv.e);',
        '    if (ab_d2(a, b) > AB_EPS) best = { P: g.P, pri: g.pri, a: a, b: b };',
        '  }',
        '  mv.d = best;',
        '}',
        // Progress of a curve along a -> b at t: the projection of the value onto the
        // line from a to b, so the box keeps the layer's easing, overshoot and bounce.
        'function ab_proj(d, t) {',
        '  var v = d.P.valueAtTime(t);',
        '  if (typeof v == "number") return (v - d.a) / (d.b - d.a);',
        '  var num = 0, den = 0;',
        '  for (var i = 0; i < v.length; i++) {',
        '    num += (v[i] - d.a[i]) * (d.b[i] - d.a[i]);',
        '    den += (d.b[i] - d.a[i]) * (d.b[i] - d.a[i]);',
        '  }',
        '  return num / den;',
        '}',
        'function ab_ease(f) {',
        '  if (AB_EASE == 2) return f * f * f;',
        '  if (AB_EASE == 3) return 1 - (1 - f) * (1 - f) * (1 - f);',
        '  if (AB_EASE == 4) return f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;',
        '  return f;',
        '}',
        // ---- events
        // A morph: the box changes shape over [s, e], borrowing a move's curve (d,
        // renormalized to start at 0 when it begins mid-move) or else using Morph
        // Time and Morph Ease. snap: no morph at all. T: when the member is measured.
        'var AB_SEQ = 0;',
        'function ab_morph(m, kind, s, mv, T) {',
        '  var ev = { m: m, kind: kind, s: s, e: s + AB_MT, d: null, p0: 0, T: T, snap: AB_MT <= 0, seq: AB_SEQ++ };',
        '  if (mv && mv.d && mv.e - s > AB_FD / 2) {',
        '    var p0 = s > mv.s ? ab_proj(mv.d, s) : 0;',
        '    if (p0 < 0.95) {',
        '      ev.d = mv.d; ev.p0 = p0; ev.e = mv.e; ev.snap = false;',
        '    }',
        '  }',
        '  return ev;',
        '}',
        'function ab_prog(ev, t) {',
        '  if (t < ev.s) return 0;',
        '  if (ev.snap || t >= ev.e) return 1;',
        '  if (ev.d) return (ab_proj(ev.d, t) - ev.p0) / (1 - ev.p0);',
        '  return ab_ease((t - ev.s) / (ev.e - ev.s));',
        '}',
        // A move that changes nothing in the end (there and back) needs no morph.
        'function ab_repos(m, mv, out) {',
        '  var instant = mv.e - mv.s < AB_FD / 2;',
        '  for (var i = 0; i < mv.segs.length && !instant; i++) if (!mv.segs[i].P) instant = true;',
        '  if (mv.d || instant) out.push(ab_morph(m, "move", mv.s, mv.d ? mv : null, mv.e));',
        '}',
        // Automatic: the first move brings the member in, the last one (if there are
        // two or more) takes it out, the ones between reposition it. No moves: it's
        // in from its in point. Its out point takes it out. Source Text changes only
        // resize it while it's in.
        'function ab_auto(m, mv, out, leaves) {',
        '  var half = AB_FD / 2, motion = [], i, n, enter, exit = 1e9;',
        '  for (i = 0; i < mv.length; i++) if (!mv[i].txt) motion.push(mv[i]);',
        '  n = motion.length;',
        '  if (!n) {',
        '    var ev = ab_morph(m, "in", m.lin, null, m.lin);',
        '    if (m.lin <= AB_IN + half) ev.snap = true;',
        '    out.push(ev);',
        '    enter = m.lin;',
        '  } else {',
        '    enter = Math.max(m.lin, motion[0].s);',
        '    out.push(ab_morph(m, "in", enter, motion[0], motion[0].e));',
        '    for (i = 1; i < n - 1; i++) ab_repos(m, motion[i], out);',
        '    if (n > 1) {',
        '      exit = motion[n - 1].s;',
        '      leaves.push({ m: m, s: exit });',
        '    }',
        '  }',
        '  for (i = 0; i < mv.length; i++) {',
        '    if (mv[i].txt && mv[i].s > enter + half && mv[i].s < exit) ab_repos(m, mv[i], out);',
        '  }',
        '}',
        // In Box checkbox: in while it's on.
        'function ab_override(m, ib, mv, out, leaves) {',
        '  var half = AB_FD / 2, lin = m.lin, lout = m.lout, i, j;',
        '  var on = ib.valueAtTime(lin) > 0, sw = on ? [[lin, true]] : [];',
        '  for (i = 1; i <= ib.numKeys; i++) {',
        '    var k = ib.key(i), v = k.value > 0;',
        '    if (k.time <= lin || k.time >= lout || v == on) continue;',
        '    sw.push([k.time, v]);',
        '    on = v;',
        '  }',
        '  for (i = 0; i < sw.length; i++) {',
        '    var a = sw[i][0];',
        '    if (!sw[i][1]) {',
        '      leaves.push({ m: m, s: a });',
        '      continue;',
        '    }',
        '    var end = i + 1 < sw.length ? sw[i + 1][0] : lout, cur = null;',
        '    for (j = 0; j < mv.length; j++) {',
        '      if (mv[j].s <= a + half && mv[j].e > a + half) { cur = mv[j]; break; }',
        '    }',
        '    var ev = ab_morph(m, "in", a, cur, cur ? cur.e : a);',
        '    if (!cur && a <= AB_IN + half) ev.snap = true;',
        '    out.push(ev);',
        '    for (j = 0; j < mv.length; j++) {',
        '      if (mv[j] !== cur && mv[j].s > a + half && mv[j].s < end) ab_repos(m, mv[j], out);',
        '    }',
        '  }',
        '}',
        // The moves that happen while the member exists.
        'function ab_movesIn(m) {',
        '  var all = ab_moves(m), mv = [], L = m.L;',
        '  for (var j = 0; j < all.length; j++) {',
        '    if (all[j].e >= m.lin - AB_FD / 2 && all[j].s < m.lout) mv.push(all[j]);',
        '  }',
        '  return mv;',
        '}',
        'function ab_events(members) {',
        '  var out = [], leaves = [], half = AB_FD / 2, i, j;',
        '  for (i = 0; i < members.length; i++) {',
        '    var m = members[i], mv = ab_movesIn(m), ib = null;',
        '    try { ib = m.L.effect("In Box")(1); } catch (err) {}',
        '    if (ib) ab_override(m, ib, mv, out, leaves);',
        '    else ab_auto(m, mv, out, leaves);',
        '    if (m.lout < AB_BOX.outPoint - half) leaves.push({ m: m, s: m.lout });',
        '  }',
        '  out.sort(function (x, y) { return x.s - y.s || x.seq - y.seq; });',
        // Who is in for each morph: entered by its start, not leaving by its end.
        '  var E = [];',
        '  for (i = 0; i < out.length; i++) {',
        '    var ek = out[i], ins = [];',
        '    for (j = 0; j < members.length; j++) {',
        '      var mj = members[j], enter = null, T = null, x;',
        '      for (x = 0; x <= i; x++) {',
        '        if (out[x].m !== mj) continue;',
        '        if (out[x].kind == "in") enter = out[x].s;',
        '        if (enter !== null) T = out[x].T;',
        '      }',
        '      if (enter === null) continue;',
        '      var gone = false;',
        '      for (x = 0; x < leaves.length; x++) {',
        '        if (leaves[x].m === mj && leaves[x].s >= enter && leaves[x].s <= ek.e) gone = true;',
        '      }',
        '      if (!gone) ins.push([mj, T]);',
        '    }',
        '    if (ins.length) {',
        '      ek.ins = ins;',
        '      E.push(ek);',
        '    }',
        '  }',
        '  return E;',
        '}',
        // ---- the box over time
        'function ab_pad(u) {',
        '  if (!u || u.l > u.r) return null;',
        '  var ax = AB_ANCHOR % 3, ay = Math.floor(AB_ANCHOR / 3);',
        '  var gx = ab_grow(u.l - AB_PL, u.r + AB_PR, AB_MINW, ax), gy = ab_grow(u.t - AB_PT, u.b + AB_PB, AB_MINH, ay);',
        '  return { l: gx[0], t: gy[0], r: gx[1], b: gy[1] };',
        '}',
        'function ab_grow(lo, hi, min, a) {',
        '  var d = min - (hi - lo);',
        '  if (d <= 0) return [lo, hi];',
        '  if (a == 0) return [lo, hi + d];',
        '  if (a == 1) return [lo - d / 2, hi + d / 2];',
        '  return [lo - d, hi];',
        '}',
        'function ab_union(list, now) {',
        '  var u = { l: Infinity, t: Infinity, r: -Infinity, b: -Infinity };',
        '  for (var i = 0; i < list.length; i++) {',
        '    var g = ab_geom(list[i][0], list[i][1], now);',
        '    u.l = Math.min(u.l, g.l); u.t = Math.min(u.t, g.t); u.r = Math.max(u.r, g.r); u.b = Math.max(u.b, g.b);',
        '  }',
        '  return ab_pad(u);',
        '}',
        // A zero-size rect at r's Box Anchor point: where the box grows from.
        'function ab_seed(r) {',
        '  var ax = AB_ANCHOR % 3, ay = Math.floor(AB_ANCHOR / 3);',
        '  var x = r.l + (r.r - r.l) * ax / 2, y = r.t + (r.b - r.t) * ay / 2;',
        '  return { l: x, t: y, r: x, b: y };',
        '}',
        'function ab_mix(a, b, p) {',
        '  if (!a) a = ab_seed(b);',
        '  var r = { l: a.l + (b.l - a.l) * p, t: a.t + (b.t - a.t) * p, r: a.r + (b.r - a.r) * p, b: a.b + (b.b - a.b) * p };',
        '  if (r.r < r.l) r.l = r.r = (r.l + r.r) / 2;',
        '  if (r.b < r.t) r.t = r.b = (r.t + r.b) / 2;',
        '  return r;',
        '}',
        // Smart Animate: each morph runs from wherever the box is when it starts.
        'function ab_smart(E, t) {',
        '  if (!E.length) return null;',
        '  if (t < E[0].s) return ab_seed(ab_union(E[0].ins, E[0].s));',
        '  var from = null, last = 0;',
        '  for (var k = 1; k < E.length && E[k].s <= t; k++) {',
        '    from = ab_mix(from, ab_union(E[last].ins, E[k].s), ab_prog(E[last], E[k].s));',
        '    last = k;',
        '  }',
        '  return ab_mix(from, ab_union(E[last].ins, t), ab_prog(E[last], t));',
        '}',
        // Smart Animate off: wrap whatever is visible right now.
        'function ab_live(members, t) {',
        '  var list = [];',
        '  for (var i = 0; i < members.length; i++) {',
        '    if (t >= members[i].lin && t < members[i].lout) list.push([members[i], t]);',
        '  }',
        '  return list.length ? ab_union(list, t) : null;',
        '}',
        // Freeze: runs of the checkbox being on, as [start, end).
        'function ab_runs() {',
        '  var F = ab_ctlProp("Freeze"), runs = [];',
        '  if (!F) return runs;',
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
        'function ab_solve() {',
        '  if (!AB_BOX) return null;',
        '  var members = ab_members(), E = AB_SMART ? ab_events(members) : null;',
        '  var at = function (t) { return AB_SMART ? ab_smart(E, t) : ab_live(members, t); };',
        '  var runs = ab_runs(), half = AB_FD / 2, i, r;',
        '  for (i = 0; i < runs.length; i++) {',
        '    r = runs[i];',
        '    if (AB_T < r[0] || AB_T >= r[1]) continue;',
        '    if (r[0] <= AB_IN + half) return at(r[1] < 1e8 ? r[1] : AB_IN);',
        '    return at(r[0]);',
        '  }',
        '  for (i = 0; i < runs.length; i++) {',
        '    r = runs[i];',
        '    if (r[0] > AB_IN + half && AB_T >= r[1] && AB_T < r[1] + AB_MT) {',
        '      var held = at(r[0]), now = at(AB_T);',
        '      if (!held || !now) return now || held;',
        '      return ab_mix(held, now, ab_ease((AB_T - r[1]) / AB_MT));',
        '    }',
        '  }',
        '  return at(AB_T);',
        '}',
        // For the In Box button: member idx's automatic switches, [time, 1 in / 0 out].
        'function ab_switchesOf(idx) {',
        '  var members = ab_members(), sw = [], i, j;',
        '  for (i = 0; i < members.length; i++) {',
        '    if (members[i].L.index != idx) continue;',
        '    var out = [], leaves = [];',
        '    ab_auto(members[i], ab_movesIn(members[i]), out, leaves);',
        '    for (j = 0; j < out.length; j++) if (out[j].kind == "in") sw.push([out[j].s, 1]);',
        '    for (j = 0; j < leaves.length; j++) sw.push([leaves[j].s, 0]);',
        '  }',
        '  sw.sort(function (a, b) { return a[0] - b[0]; });',
        '  return sw;',
        '}'
    ].join("\n");

    var TAILS = {
        size: 'var ab_r = ab_solve() || { l: 0, t: 0, r: 0, b: 0 };\n[ab_r.r - ab_r.l, ab_r.b - ab_r.t];',
        position: 'var ab_r = ab_solve() || { l: 0, t: 0, r: 0, b: 0 };\n[(ab_r.l + ab_r.r) / 2, (ab_r.t + ab_r.b) / 2];'
    };

    // kind: "size" | "position" (the box's rect).
    function buildExpression(kind) {
        return EXPR_TAG + " box: sized from the layers parented to it. Change it in Effect Controls.\n" +
            "var AB_BOX = thisLayer;\n" + ENGINE + "\n" + TAILS[kind];
    }

    // A temporary expression on the box that reports the automatic in/out
    // switches of one member: [time, 1 = in / 0 = out] number k, or [-1, -1].
    function buildSwitchProbe(memberIndex, k) {
        return "var AB_BOX = thisLayer;\n" + ENGINE + "\n" +
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
    // 3 radial) and angle (0 = up, 90 = left to right).
    function gradientPoints(type, angle) {
        if (type == 3) return [[0, 0], [50, 50]];
        var a = angle * Math.PI / 180, dx = Math.sin(a), dy = -Math.cos(a);
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

    function rigParts(box) {
        var group = rigGroup(box);
        var rect = group.property("ADBE Vectors Group").property("ADBE Vector Shape - Rect");
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

    // (Re)apply the box's expressions. Members never get any.
    function rigBox(box) {
        var parts = rigParts(box);
        setExpression(parts.size, buildExpression("size"));
        setExpression(parts.position, buildExpression("position"));
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

        var fillType = Math.round(s.fillType), strokeType = Math.round(s.strokeType), stroked = s.strokeWidth > 0;
        var fill = item("Fill");
        setNative(fill.property("ADBE Vector Fill Color"), [s.fillColor[0], s.fillColor[1], s.fillColor[2], 1]);
        setNative(fill.property("ADBE Vector Fill Opacity"), s.fillOpacity);
        setEnabled(fill, fillType == 1);
        paintGradient(box, "Gradient Fill", fillType, s.fillAngle, s.fillOpacity, null);
        setEnabled(item("Gradient Fill"), fillType != 1);

        var stroke = item("Stroke");
        setNative(stroke.property("ADBE Vector Stroke Color"), [s.strokeColor[0], s.strokeColor[1], s.strokeColor[2], 1]);
        setNative(stroke.property("ADBE Vector Stroke Width"), Math.max(0, s.strokeWidth));
        setNative(stroke.property("ADBE Vector Stroke Opacity"), s.strokeOpacity);
        setEnabled(stroke, stroked && strokeType == 1);
        paintGradient(box, "Gradient Stroke", strokeType, s.strokeAngle, s.strokeOpacity, Math.max(0, s.strokeWidth));
        setEnabled(item("Gradient Stroke"), stroked && strokeType != 1);
    }

    // A gradient not in use still gets a type and points that span the box,
    // so switching it on by its eyeball just works.
    function paintGradient(box, name, type, angle, opacity, width) {
        var g = vectors(box, RIG_GROUP).property(name);
        setNative(g.property("ADBE Vector Grad Type"), type == 3 ? 2 : 1);
        var pts = gradientPoints(type == 3 ? 3 : 2, angle);
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

    function fitTiming(box, members) {
        var tin = members[0].inPoint, tout = members[0].outPoint;
        for (var i = 1; i < members.length; i++) {
            tin = Math.min(tin, members[i].inPoint);
            tout = Math.max(tout, members[i].outPoint);
        }
        try {
            if (tin < box.startTime) box.startTime = tin;
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

    // Pin a position that an AutoBox 1.x/2.x layout expression drives at what
    // it shows (keyframes if it changes). Re-parenting compensates the stored
    // value, not the expression's result, so without this a layer would jump.
    // Expressions that pass the value through are just removed.
    function freeze(comp, layer) {
        var props = positionProps(layer);
        for (var i = 0; i < props.length; i++) {
            var p = props[i];
            if (!isRigExpression(p)) continue;
            if (p.numKeys > 0) {
                bakeProperty(comp, p, layerTimeRange(comp, layer));
                continue;
            }
            var v = p.valueAtTime(comp.time, false);
            p.expression = "";
            p.setValue(v);
        }
    }

    // Parent the top-level layers to the box (the rest ride along).
    function adopt(comp, box, layers) {
        var top = topLevel(layers), moving = [], i;
        for (i = 0; i < top.length; i++) {
            if (!sameLayer(top[i].parent, box)) moving.push(top[i]);
        }
        for (i = 0; i < moving.length; i++) freeze(comp, moving[i]);
        for (i = 0; i < moving.length; i++) moving[i].parent = box;
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

    // Carry an old control's keyframes over to the native property.
    function carryKeys(box, name, prop) {
        var effect = findControl(box, name);
        if (!effect || !prop) return;
        var src = effect.property(1);
        if (src.numKeys == 0) return;
        for (var i = 1; i <= src.numKeys; i++) prop.setValueAtTime(src.keyTime(i), src.keyValue(i));
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
        s.strokeWidth = oldControl(box, "Stroke Width", t, 0);
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
        paintBox(box, s);
        var item = function (name, match) { return vectors(box, RIG_GROUP).property(name).property(match); };
        carryKeys(box, "Corner Radius", rigParts(box).roundness);
        carryKeys(box, "Fill Color", item("Fill", "ADBE Vector Fill Color"));
        carryKeys(box, "Fill Opacity", item(s.fillType == 1 ? "Fill" : "Gradient Fill", "ADBE Vector Fill Opacity"));
        carryKeys(box, "Stroke Color", item("Stroke", "ADBE Vector Stroke Color"));
        carryKeys(box, "Stroke Width", item(s.strokeType == 1 ? "Stroke" : "Gradient Stroke", "ADBE Vector Stroke Width"));
        carryKeys(box, "Stroke Opacity", item(s.strokeType == 1 ? "Stroke" : "Gradient Stroke", "ADBE Vector Stroke Opacity"));

        for (i = 0; i < OLD_CONTROLS.length; i++) {
            var effect = findControl(box, OLD_CONTROLS[i]);
            if (effect) effect.remove();
        }
        ensureControls(box, DEFAULTS, t);
        rigBox(box);
        return result;
    }

    // Ask before converting old boxes. Returns { boxIndex: null (don't) or
    // { adoptOutside } } for each old box.
    function askConvert(comp, boxes) {
        var old = [], names = [], answers = {}, i;
        for (i = 0; i < boxes.length; i++) {
            if (isOldBox(boxes[i])) {
                old.push(boxes[i]);
                names.push(boxes[i].name);
            }
        }
        if (!old.length) return answers;
        var ok = confirm(names.join(", ") + (old.length > 1 ? " were" : " was") + " made with an older AutoBox. " +
            "Convert to AutoBox " + VERSION + "?\n\nThe layers in it lose their AutoBox expressions and stay where they are " +
            "(a stack becomes plain layers). Its fill and stroke become native shape properties in its Contents; " +
            "gradient colors go back to white and black.", false, SCRIPT_NAME);
        for (i = 0; i < old.length; i++) {
            if (!ok) {
                answers[old[i].index] = null;
                continue;
            }
            var cuts = isLegacyBox(old[i]) ? legacyCuts(comp, old[i]) : [];
            answers[old[i].index] = {
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
            paintBox(box, s);
            rigBox(box);
            adopt(comp, box, members);

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
        var answers = askConvert(comp, [box]);
        if (answers[box.index] === null) return;

        app.beginUndoGroup("AutoBox: Add to Box");
        try {
            var converted = answers[box.index] ? convertBox(comp, box, answers[box.index].adoptOutside) : null;
            adopt(comp, box, added);
            var members = directMembers(comp, box);
            var lowest = lowestLayer(members.concat(added));
            if (lowest.index > box.index) box.moveAfter(lowest);
            fitTiming(box, members.concat(added));
            rigBox(box);
            checkRig(comp, box);
            if (converted) reportConversions([converted]);
        } finally {
            app.endUndoGroup();
        }
    }

    function removeFromBox() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, picked = [], inBox = [], i;
        for (i = 0; i < sel.length; i++) {
            if (isOldStrokeLayer(sel[i])) continue;
            var owner = ownerBox(sel[i]);
            if (owner || hasRigExpression(sel[i])) {
                picked.push(sel[i]);
                inBox.push(!!owner);
            }
        }
        if (!picked.length) {
            alert("Select the layers you want to take out of their box.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: Remove from Box");
        try {
            // Layers of an old (2.x) stack carry layout expressions: bake them
            // all first, since unparenting one changes the layout of the others.
            for (i = 0; i < picked.length; i++) releaseMember(comp, picked[i]);
            // A 1.x member can carry a stale AutoBox expression while parented to
            // something else (a controller null): keep that link.
            for (i = 0; i < picked.length; i++) {
                if (inBox[i]) picked[i].parent = null;
            }
        } finally {
            app.endUndoGroup();
        }
    }

    // Push the panel's settings onto the selected boxes. Animated controls
    // and properties are left alone. Old boxes are only converted the first
    // time, so their own look survives.
    function applySettings(s) {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), converted = [];
        if (!boxes.length) return;
        var answers = askConvert(comp, boxes);
        app.beginUndoGroup("AutoBox: Apply Settings");
        try {
            for (var i = 0; i < boxes.length; i++) {
                if (isOldBox(boxes[i])) {
                    var a = answers[boxes[i].index];
                    if (a) converted.push(convertBox(comp, boxes[i], a.adoptOutside));
                    continue;
                }
                setControls(boxes[i], s, comp.time, true);
                paintBox(boxes[i], s);
                rigBox(boxes[i]);
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
        var boxes = selectedBoxes(comp), plans = [], i, j;
        if (!boxes.length) return;
        for (i = 0; i < boxes.length; i++) {
            if (isOldBox(boxes[i])) {
                alert(boxes[i].name + " was made with an older AutoBox. Click Apply to Box to convert it first.", SCRIPT_NAME);
                return;
            }
            var members = boxMembers(comp, boxes[i]), layers = [], all = true;
            for (j = 0; j < members.length; j++) {
                if (!(members[j] instanceof AVLayer) || !members[j].hasVideo || members[j].locked) continue;
                if (typeof members[j].setTrackMatte !== "function") {
                    alert("Using any layer as a track matte needs After Effects 2023 (23.0) or newer.\n\n" +
                        "In older versions, duplicate the box, put the copy right above a layer and pick Alpha Matte " +
                        "in that layer's Track Matte menu.", SCRIPT_NAME);
                    return;
                }
                layers.push(members[j]);
                if (!sameLayer(members[j].trackMatteLayer, boxes[i])) all = false;
            }
            if (layers.length) plans.push({ box: boxes[i], layers: layers, off: all });
        }
        if (!plans.length) {
            alert("There are no layers in the selected box to matte.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: Matte");
        try {
            for (i = 0; i < plans.length; i++) {
                var p = plans[i];
                for (j = 0; j < p.layers.length; j++) {
                    if (p.off) p.layers[j].setTrackMatte(null, TrackMatteType.NO_TRACK_MATTE);
                    else p.layers[j].setTrackMatte(p.box, TrackMatteType.ALPHA);
                }
                // Becoming a matte switches the box's video off: it's also the background.
                p.box.enabled = true;
            }
        } finally {
            app.endUndoGroup();
        }
    }

    // A member's automatic in/out switches, read through a temporary
    // expression on its box: [[time, 1 or 0], ...].
    function autoSwitches(comp, box, layer) {
        var fx = box.property("ADBE Effect Parade"), out = [];
        var index = fx.addProperty("ADBE Point Control").propertyIndex;
        try {
            for (var k = 0; k < 200; k++) {
                var point = fx.property(index).property(1);
                setExpression(point, buildSwitchProbe(layer.index, k));
                var v = point.valueAtTime(comp.time, false);
                if (point.expressionError || v[1] < 0) break;
                out.push([v[0], v[1]]);
            }
        } finally {
            fx.property(index).remove();
        }
        return out;
    }

    // Give a layer an In Box checkbox keyed to what AutoBox does on its own,
    // so nothing changes until you edit the keys.
    function addInBox(layer, switches, frame) {
        var fx = layer.property("ADBE Effect Parade");
        fx.addProperty(CONTROL_MATCH.checkbox).name = IN_BOX;
        var box = fx.property(IN_BOX).property(1), keys = [], last = null, i;
        for (i = 0; i < switches.length; i++) {
            var on = switches[i][1] > 0;
            if (switches[i][0] >= layer.outPoint - frame / 2 || on === last) continue;
            keys.push([switches[i][0], on]);
            last = on;
        }
        if (!keys.length || (keys.length == 1 && keys[0][1] && keys[0][0] <= layer.inPoint + frame / 2)) {
            box.setValue(1);
            return;
        }
        if (keys[0][1] && keys[0][0] > layer.inPoint + frame / 2) keys.unshift([layer.inPoint, false]);
        for (i = 0; i < keys.length; i++) box.setValueAtTime(keys[i][0], keys[i][1] ? 1 : 0);
        // Checkbox keys are hold keys; make sure.
        for (i = 1; i <= box.numKeys; i++) {
            try { box.setInterpolationTypeAtKey(i, KeyframeInterpolationType.HOLD, KeyframeInterpolationType.HOLD); } catch (err) {}
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
            else if (findControl(layer, IN_BOX)) skipped.push(layer.name + " — it already has an In Box checkbox");
            else if (layer.locked) skipped.push(layer.name + " — layer is locked");
            else picked.push({ layer: layer, box: box });
        }
        if (!picked.length) {
            alert(skipped.length ? "Skipped:\n" + skipped.join("\n") : "Select layers inside a box first.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: In Box");
        try {
            // Read every layer before adding any checkbox: a checkbox changes
            // how its layer is read.
            for (i = 0; i < picked.length; i++) picked[i].switches = autoSwitches(comp, picked[i].box, picked[i].layer);
            for (i = 0; i < picked.length; i++) addInBox(picked[i].layer, picked[i].switches, comp.frameDuration);
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
        if (!confirm("Release " + boxes.length + " box(es)?\n\nThe box's size is baked into plain values/keyframes and " +
                "stops following its layers. Its fill and stroke stay.", false, SCRIPT_NAME)) return;

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
                    for (j = 0; j < members.length; j++) releaseMember(comp, members[j]);
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
            "SMART ANIMATE — the box follows the layers' keyframes, not every frame: a layer's",
            "first move brings it in, its last move (if it has two or more) takes it out, and the",
            "box morphs to fit the layers that are in, on the curve of the move that brought them.",
            "Layers leaving don't shrink it until the next one comes in. Layers without keyframes",
            "come in at their in point over Morph Time. Freeze (Effect Controls) holds the box.",
            "IN BOX adds a checkbox to the selected layers: keyframe it to say yourself when a",
            "layer counts. MATTE uses the box as its layers' track matte (After Effects 2023+).",
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
        button(g, "In Box", addInBoxToggles, "Add a keyframeable In Box checkbox to the selected layers: on = the box fits the layer");
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
