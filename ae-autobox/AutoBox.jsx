/*
 * AutoBox.jsx — Braised Tools
 *
 * Auto-sizing background boxes with padding, rounded corners and auto layout
 * for Adobe After Effects 2020 (17.0.1) or newer. Works with both the
 * JavaScript and the Legacy ExtendScript expression engines.
 *
 * Install
 *   Install dist/AutoBox.zxp with ZXP Installer (Window > Extensions > AutoBox),
 *   or copy this file into After Effects' "Scripts/ScriptUI Panels" folder,
 *   restart After Effects, then open Window > AutoBox.jsx.
 *
 * Use
 *   1. Select the layers you want boxed (text, shapes, footage, precomps).
 *   2. Pick a layout, padding and corner radius, then click "Create Box".
 *   3. Tweak (and keyframe) everything live in the box layer's Effect Controls.
 */

(function AutoBoxPanel(thisObj) {
    var SCRIPT_NAME = "AutoBox";
    var VERSION = "2.0.0";
    var SETTINGS_SECTION = "BraisedAutoBox";
    var RIG_GROUP = "AutoBox";
    var STROKE_GROUP = "AutoBox Stroke";
    var RECT_NAME = "Box Rect";
    var EXPR_TAG = "// AutoBox";

    var LAYOUTS = ["Free (wrap)", "Vertical Stack", "Horizontal Stack"];
    var ALIGNS = ["Start (Left/Top)", "Center", "End (Right/Bottom)"];
    var JUSTIFIES = ["Start", "Center", "End", "Space Between"];
    var ANCHORS = ["Top Left", "Top", "Top Right", "Left", "Center", "Right", "Bottom Left", "Bottom", "Bottom Right"];
    var PAINT_TYPES = ["Solid", "Linear Gradient", "Radial Gradient"];

    // Effect Controls added to every box layer, in order. The generated
    // expressions look these up by name, so keep them in sync with ENGINE.
    // "keep" controls survive a Release because the fill/stroke still use them.
    var CONTROLS = [
        { key: "layout", name: "Layout", type: "dropdown", items: LAYOUTS },
        { key: "gap", name: "Gap", type: "slider" },
        { key: "align", name: "Align", type: "dropdown", items: ALIGNS },
        { key: "justify", name: "Justify", type: "dropdown", items: JUSTIFIES },
        { key: "anchor", name: "Box Anchor", type: "dropdown", items: ANCHORS },
        { key: "padding", name: "Padding", type: "slider" },
        { key: "extraTop", name: "Extra Top", type: "slider" },
        { key: "extraRight", name: "Extra Right", type: "slider" },
        { key: "extraBottom", name: "Extra Bottom", type: "slider" },
        { key: "extraLeft", name: "Extra Left", type: "slider" },
        { key: "radius", name: "Corner Radius", type: "slider" },
        { key: "minWidth", name: "Min Width", type: "slider" },
        { key: "minHeight", name: "Min Height", type: "slider" },
        { key: "ignoreHidden", name: "Ignore Hidden", type: "checkbox" },
        { key: "fillType", name: "Fill Type", type: "dropdown", items: PAINT_TYPES, keep: true },
        { key: "fillColor", name: "Fill Color", type: "color", keep: true },
        { key: "fillColor2", name: "Fill Color 2", type: "color", keep: true },
        { key: "fillAngle", name: "Fill Angle", type: "angle", keep: true },
        { key: "fillOpacity", name: "Fill Opacity", type: "slider", keep: true },
        { key: "strokeWidth", name: "Stroke Width", type: "slider", keep: true },
        { key: "strokeType", name: "Stroke Type", type: "dropdown", items: PAINT_TYPES, keep: true },
        { key: "strokeColor", name: "Stroke Color", type: "color", keep: true },
        { key: "strokeColor2", name: "Stroke Color 2", type: "color", keep: true },
        { key: "strokeAngle", name: "Stroke Angle", type: "angle", keep: true },
        { key: "strokeOpacity", name: "Stroke Opacity", type: "slider", keep: true }
    ];

    var CONTROL_MATCH = {
        slider: "ADBE Slider Control",
        color: "ADBE Color Control",
        checkbox: "ADBE Checkbox Control",
        angle: "ADBE Angle Control",
        dropdown: "ADBE Dropdown Control"
    };

    var DEFAULTS = {
        layout: 1,
        gap: 16,
        align: 1,
        justify: 1,
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
        fillType: 1,
        fillColor: [27 / 255, 54 / 255, 67 / 255],
        fillColor2: [0, 166 / 255, 105 / 255],
        fillAngle: 90,
        fillOpacity: 100,
        strokeType: 1,
        strokeColor: [0, 166 / 255, 105 / 255],
        strokeColor2: [1, 1, 1],
        strokeAngle: 90,
        strokeWidth: 0,
        strokeOpacity: 100
    };

    // ------------------------------------------------------------------
    // Expression engine
    //
    // A box's members are the layers parented to it: no layer names are
    // involved, so editing text, renaming, reordering or duplicating layers
    // can't break a box. Direct children take a slot in a stack; layers
    // parented to a member ride along with it. Every rigged property gets the
    // same engine. It is written in ES3 so it runs on the Legacy ExtendScript
    // engine as well as the JavaScript engine.
    // ------------------------------------------------------------------
    var ENGINE = [
        'var AB_T = time;',
        'function ab_ctl(n, d) { try { return AB_BOX.effect(n)(1).value; } catch (err) { return d; } }',
        // 0 means AB_BOX isn't a box (no Layout control): leave things alone.
        'var AB_MODE = AB_BOX ? Math.round(ab_ctl("Layout", 0)) : 0;',
        'var AB_GAP = ab_ctl("Gap", 0);',
        'var AB_ALIGN = Math.round(ab_ctl("Align", 1));',
        'var AB_JUSTIFY = Math.round(ab_ctl("Justify", 1));',
        'var AB_ANCHOR = Math.min(8, Math.max(0, Math.round(ab_ctl("Box Anchor", 1)) - 1));',
        'var AB_PAD = ab_ctl("Padding", 0);',
        'var AB_PT = AB_PAD + ab_ctl("Extra Top", 0);',
        'var AB_PR = AB_PAD + ab_ctl("Extra Right", 0);',
        'var AB_PB = AB_PAD + ab_ctl("Extra Bottom", 0);',
        'var AB_PL = AB_PAD + ab_ctl("Extra Left", 0);',
        'var AB_MINW = ab_ctl("Min Width", 0);',
        'var AB_MINH = ab_ctl("Min Height", 0);',
        'var AB_SKIP = ab_ctl("Ignore Hidden", 1) > 0;',
        // Text layers are measured without extents (for paragraph text that
        // would be the paragraph box); shapes include their stroke.
        'function ab_isText(L) { try { return L.text.sourceText !== undefined; } catch (err) { return false; } }',
        // A box's own stroke layer is parented to it but isn't a member.
        'function ab_isStrokeLayer(L) { try { L.content("AutoBox Stroke"); return true; } catch (err) { return false; } }',
        // For a nested box: half its stroke, which sits outside its rect.
        // -1 when L isn't a box (released boxes still count: they keep the
        // AutoBox group and their stroke).
        'function ab_outline(L) {',
        '  try { L.content("AutoBox"); } catch (err) { return -1; }',
        '  var w = 0, o = 100;',
        '  try { w = L.effect("Stroke Width")(1).value; } catch (err2) {}',
        '  try { o = L.effect("Stroke Opacity")(1).value; } catch (err3) {}',
        '  return (w > 0 && o > 0) ? w / 2 : 0;',
        '}',
        // Every visible layer whose parent chain reaches the box, in timeline
        // order, with its metrics. direct: parented straight to the box (gets
        // a stack slot). Anything that can't be measured (a camera or light
        // parented to the box) is skipped rather than breaking the box.
        'function ab_members() {',
        '  var out = [], n = thisComp.numLayers, bi = AB_BOX.index, stack = AB_MODE == 2 || AB_MODE == 3;',
        '  for (var i = 1; i <= n; i++) {',
        '    if (i == bi) continue;',
        '    try {',
        '      var L = thisComp.layer(i);',
        '      if (!L.hasParent || L.hasVideo !== true) continue;',
        '      var p = L, g = 0, direct = true, hit = false;',
        '      while (p.hasParent && g++ < 50) {',
        '        p = p.parent;',
        '        if (p.index == bi) { hit = true; break; }',
        '        direct = false;',
        '      }',
        // Stacks only lay out direct children; riders don't need measuring.
        '      if (!hit || (stack && !direct)) continue;',
        // A hidden direct member keeps a zero-size spot in a stack so any
        // visible children it carries stay put.
        '      var ghost = AB_SKIP && !L.active;',
        '      if (ghost && !stack) continue;',
        '      var text = ab_isText(L);',
        '      if (direct && !text && ab_isStrokeLayer(L)) continue;',
        '      var line = text ? -1 : ab_outline(L);',
        '      var m = ab_metrics(L, !text && line < 0, line > 0 ? line : 0);',
        '      m.L = L;',
        '      m.direct = direct;',
        '      m.ghost = ghost;',
        '      out.push(m);',
        '    } catch (err) {}',
        '  }',
        '  return out;',
        '}',
        // Map a point from L's layer space into the box's layer space. Walks
        // the parent chain by hand so it never reads the box's own transform
        // (that keeps nested boxes free of expression cycles).
        'function ab_toBox(L, x, y) {',
        '  for (var g = 0; g < 50; g++) {',
        '    var a = L.transform.anchorPoint.value, s = L.transform.scale.value, p = L.transform.position.value;',
        '    var r = L.transform.rotation.value * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);',
        '    var dx = (x - a[0]) * s[0] / 100, dy = (y - a[1]) * s[1] / 100;',
        '    x = p[0] + dx * c - dy * sn;',
        '    y = p[1] + dx * sn + dy * c;',
        '    if (!L.hasParent) { var q = AB_BOX.fromComp([x, y]); return [q[0], q[1]]; }',
        '    L = L.parent;',
        '    if (L.index == AB_BOX.index) return [x, y];',
        '  }',
        '  return [x, y];',
        '}',
        // Unrotated, scaled bounds of L relative to its position (parent space).
        'function ab_metrics(L, ext, grow) {',
        '  var sr = L.sourceRectAtTime(AB_T, ext);',
        '  if (grow) sr = { left: sr.left - grow, top: sr.top - grow, width: sr.width + 2 * grow, height: sr.height + 2 * grow };',
        '  var a = L.transform.anchorPoint.value, s = L.transform.scale.value;',
        '  var x0 = (sr.left - a[0]) * s[0] / 100, x1 = (sr.left + sr.width - a[0]) * s[0] / 100;',
        '  var y0 = (sr.top - a[1]) * s[1] / 100, y1 = (sr.top + sr.height - a[1]) * s[1] / 100;',
        '  return { idx: L.index, sr: sr, ox: Math.min(x0, x1), oy: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };',
        '}',
        // Grow [lo, hi] to at least min, keeping the anchored side fixed.
        'function ab_grow(lo, hi, min, a) {',
        '  var d = min - (hi - lo);',
        '  if (d <= 0) return [lo, hi];',
        '  if (a == 0) return [lo, hi + d];',
        '  if (a == 1) return [lo - d / 2, hi + d / 2];',
        '  return [lo - d, hi];',
        '}',
        // Solve the layout. Returns the box rect (l, t, r, b) in the box
        // layer's space and, for stacks, each item's top-left target (pos)
        // and metrics (m), keyed by layer index.
        'function ab_solve() {',
        '  var ax = AB_ANCHOR % 3, ay = Math.floor(AB_ANCHOR / 3);',
        '  var res = { l: 0, t: 0, r: 0, b: 0, pos: {}, m: {} };',
        '  if (!AB_BOX) return res;',
        '  var members = ab_members(), i, k, L;',
        '  if (AB_MODE != 2 && AB_MODE != 3) {',
        '    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;',
        '    for (i = 0; i < members.length; i++) {',
        '      L = members[i].L;',
        '      var sr = members[i].sr, xs = [sr.left, sr.left + sr.width], ys = [sr.top, sr.top + sr.height];',
        '      try {',
        '        var pts = [];',
        '        for (k = 0; k < 4; k++) pts.push(ab_toBox(L, xs[k % 2], ys[Math.floor(k / 2)]));',
        '        for (k = 0; k < 4; k++) {',
        '          l = Math.min(l, pts[k][0]); t = Math.min(t, pts[k][1]); r = Math.max(r, pts[k][0]); b = Math.max(b, pts[k][1]);',
        '        }',
        '      } catch (err) {}',
        '    }',
        '    if (l > r) return res;',
        '    var gx = ab_grow(l - AB_PL, r + AB_PR, AB_MINW, ax), gy = ab_grow(t - AB_PT, b + AB_PB, AB_MINH, ay);',
        '    res.l = gx[0]; res.r = gx[1]; res.t = gy[0]; res.b = gy[1];',
        '    return res;',
        '  }',
        '  var vert = AB_MODE == 2, items = [];',
        '  for (i = 0; i < members.length; i++) {',
        '    if (!members[i].ghost) items.push(members[i]);',
        '  }',
        '  if (!items.length) return res;',
        '  var n = items.length, mainSum = 0, cross = 0;',
        '  for (i = 0; i < n; i++) {',
        '    mainSum += vert ? items[i].h : items[i].w;',
        '    cross = Math.max(cross, vert ? items[i].w : items[i].h);',
        '  }',
        '  var main = mainSum + AB_GAP * (n - 1);',
        '  var bw = Math.max(AB_MINW, (vert ? cross : main) + AB_PL + AB_PR);',
        '  var bh = Math.max(AB_MINH, (vert ? main : cross) + AB_PT + AB_PB);',
        '  res.l = -bw * ax / 2; res.t = -bh * ay / 2; res.r = res.l + bw; res.b = res.t + bh;',
        '  var il = res.l + AB_PL, it = res.t + AB_PT;',
        '  var innerMain = vert ? bh - AB_PT - AB_PB : bw - AB_PL - AB_PR;',
        '  var innerCross = vert ? bw - AB_PL - AB_PR : bh - AB_PT - AB_PB;',
        '  var spare = innerMain - main, cursor = 0, gap = AB_GAP;',
        '  if (AB_JUSTIFY == 2) cursor = spare / 2;',
        '  else if (AB_JUSTIFY == 3) cursor = spare;',
        '  else if (AB_JUSTIFY == 4) { if (n > 1) gap += spare / (n - 1); else cursor = spare / 2; }',
        '  for (i = 0; i < members.length; i++) {',
        '    var m = members[i], sMain = vert ? m.h : m.w, sCross = vert ? m.w : m.h, off = 0;',
        '    if (AB_ALIGN == 2) off = (innerCross - sCross) / 2;',
        '    else if (AB_ALIGN == 3) off = innerCross - sCross;',
        '    res.pos[m.idx] = vert ? [il + off, it + cursor] : [il + cursor, it + off];',
        '    res.m[m.idx] = m;',
        '    if (!m.ghost) cursor += sMain + gap;',
        '  }',
        '  return res;',
        '}'
    ].join("\n");

    // Members are parented to the box, so their targets are already in the
    // box's layer space.
    var MEMBER_TAIL = [
        'var ab_out = value;',
        'if (AB_MODE == 2 || AB_MODE == 3) {',
        '  var ab_r = ab_solve(), ab_tl = ab_r.pos[thisLayer.index], ab_mm = ab_r.m[thisLayer.index];',
        '  if (ab_tl) {',
        '    var ab_x = ab_tl[0] - ab_mm.ox, ab_y = ab_tl[1] - ab_mm.oy;',
        '    ab_out = %OUT%;',
        '  }',
        '}',
        'ab_out;'
    ].join("\n");

    var TAILS = {
        size: 'var ab_r = ab_solve();\n[ab_r.r - ab_r.l, ab_r.b - ab_r.t];',
        position: 'var ab_r = ab_solve();\n[(ab_r.l + ab_r.r) / 2, (ab_r.t + ab_r.b) / 2];',
        roundness: 'var ab_r = ab_solve();\nMath.max(0, Math.min(ab_ctl("Corner Radius", 0), Math.min(ab_r.r - ab_r.l, ab_r.b - ab_r.t) / 2));',
        member: MEMBER_TAIL.replace("%OUT%", "(value.length > 2) ? [ab_x, ab_y, value[2]] : [ab_x, ab_y]"),
        memberX: MEMBER_TAIL.replace("%OUT%", "ab_x"),
        memberY: MEMBER_TAIL.replace("%OUT%", "ab_y")
    };

    // ------------------------------------------------------------------
    // Paint: fill and stroke
    //
    // After Effects can't set gradient colors from a script or an
    // expression. So a gradient is drawn with AE's own default white-to-black
    // Gradient Fill / Gradient Stroke, whose points are kept spanning the
    // box, and recolored by a Tint effect whose two colors come from Effect
    // Controls (live and keyframeable). Effects apply to a whole layer, so
    // the stroke lives on its own layer, parented to the box, and fill and
    // stroke can each have their own gradient.
    //
    // ctl is the layer holding the controls: "thisLayer" on the box,
    // "thisLayer.parent" on its stroke layer.
    // ------------------------------------------------------------------
    var FILL_TINT = "Fill Tint";
    var STROKE_TINT = "Stroke Tint";
    var PAINT_TAG = EXPR_TAG + " paint";

    function readControl(ctl, name, fallback, varName) {
        return "var " + varName + " = " + fallback + "; try { " + varName + " = " + ctl + ".effect(\"" + name + "\")(1).value; } catch (err) {}";
    }

    function colorExpression(ctl, name) {
        return [PAINT_TAG, readControl(ctl, name, "value", "c"), "c;"].join("\n");
    }

    function widthExpression(ctl) {
        return [PAINT_TAG, readControl(ctl, "Stroke Width", "value", "w"), "w;"].join("\n");
    }

    // Only the paint matching "<prefix> Type" (1 solid, 2 linear, 3 radial)
    // shows; a stroke also needs a width. When fill and stroke are both
    // solid, the stroke is drawn inside the box (place "box") so the two fade
    // together as one layer; otherwise it's drawn on the stroke layer
    // (place "layer"), where it can carry its own Tint.
    function opacityExpression(ctl, prefix, type, place) {
        var lines = [
            PAINT_TAG,
            readControl(ctl, prefix + " Type", "1", "t"),
            readControl(ctl, prefix + " Opacity", "100", "o")
        ];
        if (prefix != "Stroke") {
            lines.push("Math.round(t) == " + type + " ? o : 0;");
            return lines.join("\n");
        }
        lines.push(
            readControl(ctl, "Stroke Width", "0", "w"),
            readControl(ctl, "Fill Type", "1", "ft"),
            "var inBox = Math.round(ft) == 1 && Math.round(t) == 1;",
            "(Math.round(t) == " + type + " && w > 0 && " + (place == "box" ? "inBox" : "!inBox") + ") ? o : 0;"
        );
        return lines.join("\n");
    }

    function tintAmountExpression(ctl, prefix) {
        return [PAINT_TAG, readControl(ctl, prefix + " Type", "1", "t"), "Math.round(t) == 1 ? 0 : 100;"].join("\n");
    }

    // Start / end point of a gradient so it always spans the box (a stroke's
    // out to its outer edge). rect is an expression for the "Box Rect" path.
    // Angles follow After Effects: 0 = up, 90 = left to right.
    // Hidden gradient types skip the work and keep their value.
    function gradientPointExpression(ctl, prefix, rect, end, radial) {
        var lines = [
            PAINT_TAG,
            readControl(ctl, prefix + " Type", "1", "t"),
            "var out = value;",
            "if (Math.round(t) == " + (radial ? 3 : 2) + ") {",
            "  var r = " + rect + ";",
            "  var sz = r.size.value, ps = r.position.value;",
            "  " + (prefix == "Stroke" ? readControl(ctl, "Stroke Width", "0", "w") : "var w = 0;"),
            "  var bw = sz[0] + w, bh = sz[1] + w;"
        ];
        if (radial) {
            lines.push(end ? "  out = [ps[0] + Math.sqrt(bw * bw + bh * bh) / 2, ps[1]];" : "  out = [ps[0], ps[1]];");
        } else {
            lines.push(
                "  " + readControl(ctl, prefix + " Angle", "90", "a"),
                "  var rad = a * Math.PI / 180, dx = Math.sin(rad), dy = -Math.cos(rad);",
                "  var half = (Math.abs(bw * dx) + Math.abs(bh * dy)) / 2;",
                end ? "  out = [ps[0] + dx * half, ps[1] + dy * half];" : "  out = [ps[0] - dx * half, ps[1] - dy * half];"
            );
        }
        lines.push("}", "out;");
        return lines.join("\n");
    }

    // The stroke layer's rect copies the box's.
    function strokeRectExpression(attr) {
        return [
            PAINT_TAG,
            "thisLayer.hasParent ? thisLayer.parent.content(\"" + RIG_GROUP + "\").content(\"" + RECT_NAME + "\")." + attr + ".value : value;"
        ].join("\n");
    }

    // kind: size | position | roundness (box) or member | memberX | memberY.
    function buildExpression(kind) {
        var head;
        if (kind.indexOf("member") === 0) {
            head = EXPR_TAG + " member: laid out by its parent box. Remove it with the AutoBox panel.\n" +
                "var AB_BOX = thisLayer.hasParent ? thisLayer.parent : null;";
        } else {
            head = EXPR_TAG + " box: sized from the layers parented to it. Change it in Effect Controls.\n" +
                "var AB_BOX = thisLayer;";
        }
        return head + "\n" + ENGINE + "\n" + TAILS[kind];
    }

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

    // A live box: the AutoBox shape group plus its Layout control (Release
    // removes the control but keeps the group, so expressions still resolve).
    function isBox(layer) {
        return rigGroup(layer) !== null && findControl(layer, "Layout") !== null;
    }

    // The layer that draws a box's stroke.
    function isStrokeLayer(layer) {
        return shapeGroup(layer, STROKE_GROUP) !== null;
    }

    function strokeLayerOf(comp, box) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (layer.parent && layer.parent.index == box.index && isStrokeLayer(layer)) return layer;
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
            if (layer.index != box.index && !isStrokeLayer(layer) && sameLayer(ownerBox(layer), box)) out.push(layer);
        }
        return out;
    }

    // Layers parented straight to the box: the ones a stack lays out.
    function directMembers(comp, box) {
        var out = [];
        for (var i = 1; i <= comp.numLayers; i++) {
            var layer = comp.layer(i);
            if (sameLayer(layer.parent, box) && isUsable(layer) && !isStrokeLayer(layer)) out.push(layer);
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

    // (Re)apply the expressions: on the box, and on the position of every
    // layer parented straight to it. A position that already carries someone
    // else's expression is left alone.
    function rigBox(comp, box, blocked) {
        var parts = rigParts(box), members = directMembers(comp, box);
        setExpression(parts.size, buildExpression("size"));
        setExpression(parts.position, buildExpression("position"));
        setExpression(parts.roundness, buildExpression("roundness"));
        for (var i = 0; i < members.length; i++) {
            var props = positionProps(members[i]);
            if (props[0].expression && !isRigExpression(props[0])) {
                if (blocked) blocked.push(members[i].name);
                continue;
            }
            if (props.length == 1) {
                setExpression(props[0], buildExpression("member"));
            } else {
                setExpression(props[0], buildExpression("memberX"));
                setExpression(props[1], buildExpression("memberY"));
            }
        }
        return members;
    }

    // Evaluate rigged properties and report any expression errors.
    function checkRig(comp, box) {
        var props = [], errors = [], i, j;
        var parts = rigParts(box), members = directMembers(comp, box);
        props.push([box.name, parts.size], [box.name, parts.position], [box.name, parts.roundness]);
        var fills = rigGroup(box).property("ADBE Vectors Group");
        for (i = 1; i <= fills.numProperties; i++) {
            var item = fills.property(i);
            if (item.matchName == "ADBE Vector Graphic - G-Fill") {
                props.push([box.name, item.property("ADBE Vector Grad Start Pt")], [box.name, item.property("ADBE Vector Grad End Pt")]);
            }
        }
        var strokeLayer = strokeLayerOf(comp, box);
        if (strokeLayer) {
            var strokes = shapeGroup(strokeLayer, STROKE_GROUP).property("ADBE Vectors Group");
            props.push([strokeLayer.name, strokes.property(RECT_NAME).property("ADBE Vector Rect Size")]);
            for (i = 1; i <= strokes.numProperties; i++) {
                if (strokes.property(i).matchName == "ADBE Vector Graphic - G-Stroke") {
                    props.push([strokeLayer.name, strokes.property(i).property("ADBE Vector Grad End Pt")]);
                }
            }
        }
        for (i = 0; i < members.length; i++) {
            var pp = positionProps(members[i]);
            for (j = 0; j < pp.length; j++) props.push([members[i].name, pp[j]]);
        }
        for (i = 0; i < props.length; i++) {
            try { props[i][1].valueAtTime(comp.time, false); } catch (err) {}
            if (props[i][1].expressionError) errors.push(props[i][0] + ": " + props[i][1].expressionError);
        }
        if (errors.length) {
            alert("AutoBox could not evaluate some expressions:\n\n" + errors.join("\n"), SCRIPT_NAME);
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

    function addControls(box, values, t) {
        var fx = box.property("ADBE Effect Parade");
        for (var i = 0; i < CONTROLS.length; i++) {
            var effect = addControl(fx, CONTROLS[i]);
            effect.name = CONTROLS[i].name;
            writeControl(effect.property(1), CONTROLS[i], values[CONTROLS[i].key], t);
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
            writeControl(effect.property(1), CONTROLS[i], values[CONTROLS[i].key], t);
        }
    }

    // skipAnimated: leave keyframed controls alone rather than adding a key.
    function setControls(box, values, keys, t, skipAnimated) {
        for (var i = 0; i < CONTROLS.length; i++) {
            var c = CONTROLS[i];
            if (keys && !keys[c.key]) continue;
            var effect = findControl(box, c.name);
            if (!effect || (skipAnimated && effect.property(1).numKeys > 0)) continue;
            writeControl(effect.property(1), c, values[c.key], t);
        }
    }

    // Find a shape item by name, adding it if it's missing. gradType sets a
    // gradient's Linear (1) / Radial (2) type. Returns nothing: adding a
    // property invalidates references, so callers look items up again.
    function ensureItem(contents, name, matchName, gradType) {
        if (contents.property(name)) return;
        var item = contents.addProperty(matchName);
        item.name = name;
        if (gradType) contents.property(name).property("ADBE Vector Grad Type").setValue(gradType);
    }

    function ensureTint(layer, name, ctl, prefix) {
        var fx = layer.property("ADBE Effect Parade");
        if (!fx.property(name)) fx.addProperty("ADBE Tint").name = name;
        var tint = fx.property(name);
        // The default gradient runs white -> black: white is the start color.
        setExpression(tint.property("ADBE Tint-0001"), colorExpression(ctl, prefix + " Color 2"));
        setExpression(tint.property("ADBE Tint-0002"), colorExpression(ctl, prefix + " Color"));
        setExpression(tint.property("ADBE Tint-0003"), tintAmountExpression(ctl, prefix));
    }

    // Shape items (fill, gradients) and the expressions that drive them.
    // `ctl` reads Effect Controls; `rect` finds this group's rect path.
    function paintItems(contents, ctl, prefix, rect) {
        var kind = prefix == "Fill" ? "Fill" : "Stroke";
        var solid = kind, linear = "Linear Gradient " + kind, radial = "Radial Gradient " + kind;
        var gMatch = "ADBE Vector Graphic - " + (kind == "Fill" ? "G-Fill" : "G-Stroke");
        ensureItem(contents, solid, "ADBE Vector Graphic - " + kind);
        ensureItem(contents, linear, gMatch, 1);
        ensureItem(contents, radial, gMatch, 2);
        var opacity = kind == "Fill" ? "ADBE Vector Fill Opacity" : "ADBE Vector Stroke Opacity";
        var color = kind == "Fill" ? "ADBE Vector Fill Color" : "ADBE Vector Stroke Color";
        setExpression(contents.property(solid).property(color), colorExpression(ctl, prefix + " Color"));
        var names = [solid, linear, radial];
        for (var i = 0; i < names.length; i++) {
            var item = contents.property(names[i]);
            setExpression(item.property(opacity), opacityExpression(ctl, prefix, i + 1, "layer"));
            if (kind == "Stroke") setExpression(item.property("ADBE Vector Stroke Width"), widthExpression(ctl));
            if (i > 0) {
                setExpression(item.property("ADBE Vector Grad Start Pt"), gradientPointExpression(ctl, prefix, rect, false, i == 2));
                setExpression(item.property("ADBE Vector Grad End Pt"), gradientPointExpression(ctl, prefix, rect, true, i == 2));
            }
        }
    }

    function buildShape(box) {
        var group = box.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
        group.name = RIG_GROUP;
        group.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect").name = RECT_NAME;
    }

    function pin(prop, expr) {
        setExpression(prop, PAINT_TAG + " (follows the box)\n" + expr);
    }

    // The layer that draws the box's stroke: right above the box, parented
    // to it with an identity transform so it shares the box's layer space.
    function ensureStrokeLayer(comp, box) {
        var layer = strokeLayerOf(comp, box);
        if (!layer) {
            layer = comp.layers.addShape();
            layer.name = box.name + " Stroke";
            var tr = layer.property("ADBE Transform Group");
            tr.property("ADBE Anchor Point").setValue([0, 0]);
            tr.property("ADBE Position").setValue([0, 0]);
            layer.setParentWithJump(box);
            var group = layer.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
            group.name = STROKE_GROUP;
            group.property("ADBE Vectors Group").addProperty("ADBE Vector Shape - Rect").name = RECT_NAME;
            try { layer.label = box.label; } catch (err) {}
        }
        layer.moveBefore(box);
        var t = layer.property("ADBE Transform Group");
        pin(t.property("ADBE Anchor Point"), "value.length > 2 ? [0, 0, 0] : [0, 0];");
        pin(t.property("ADBE Position"), "value.length > 2 ? [0, 0, 0] : [0, 0];");
        pin(t.property("ADBE Scale"), "value.length > 2 ? [100, 100, 100] : [100, 100];");
        pin(t.property("ADBE Rotate Z"), "0;");
        // Shows only while the box does (its switch, in/out and opacity).
        pin(t.property("ADBE Opacity"), "var p = thisLayer.hasParent ? thisLayer.parent : null;\n" +
            "p ? (p.active ? p.transform.opacity.value : 0) : value;");
        var contents = layer.property("ADBE Root Vectors Group").property(STROKE_GROUP).property("ADBE Vectors Group");
        var rect = contents.property(RECT_NAME);
        setExpression(rect.property("ADBE Vector Rect Size"), strokeRectExpression("size"));
        setExpression(rect.property("ADBE Vector Rect Position"), strokeRectExpression("position"));
        setExpression(rect.property("ADBE Vector Rect Roundness"), strokeRectExpression("roundness"));
        paintItems(contents, "thisLayer.parent", "Stroke",
            "thisLayer.content(\"" + STROKE_GROUP + "\").content(\"" + RECT_NAME + "\")");
        ensureTint(layer, STROKE_TINT, "thisLayer.parent", "Stroke");
        try {
            layer.startTime = box.startTime;
            layer.outPoint = box.outPoint;
            layer.inPoint = box.inPoint;
            layer.motionBlur = box.motionBlur;
        } catch (err) {}
        return layer;
    }

    // A stroke layer whose box was deleted is left without a parent.
    function removeOrphanStrokeLayers(comp) {
        for (var i = comp.numLayers; i >= 1; i--) {
            var layer = comp.layer(i);
            if (!layer.parent && !layer.locked && isStrokeLayer(layer)) layer.remove();
        }
    }

    var PAINT_MATCHES = {
        "ADBE Vector Graphic - Fill": true,
        "ADBE Vector Graphic - G-Fill": true,
        "ADBE Vector Graphic - Stroke": true,
        "ADBE Vector Graphic - G-Stroke": true
    };
    var BOX_PAINT = { "Stroke": true, "Fill": true, "Linear Gradient Fill": true, "Radial Gradient Fill": true };

    // Fill items + tint on the box, and its stroke layer. Safe to run again.
    // A solid stroke on a solid fill is drawn in the box itself (above the
    // fills), so fading the box fades both as one layer.
    function paintBox(comp, box) {
        var contents = rigGroup(box).property("ADBE Vectors Group"), i;
        // Boxes from older versions have unnamed "Fill 1" / "Stroke 1" items.
        for (i = contents.numProperties; i >= 1; i--) {
            var it = contents.property(i);
            if (PAINT_MATCHES[it.matchName] && !BOX_PAINT[it.name]) it.remove();
        }
        paintItems(contents, "thisLayer", "Fill",
            "thisLayer.content(\"" + RIG_GROUP + "\").content(\"" + RECT_NAME + "\")");
        ensureItem(contents, "Stroke", "ADBE Vector Graphic - Stroke");
        if (contents.property("Stroke").propertyIndex != 2) contents.property("Stroke").moveTo(2);
        var stroke = contents.property("Stroke");
        setExpression(stroke.property("ADBE Vector Stroke Color"), colorExpression("thisLayer", "Stroke Color"));
        setExpression(stroke.property("ADBE Vector Stroke Width"), widthExpression("thisLayer"));
        setExpression(stroke.property("ADBE Vector Stroke Opacity"), opacityExpression("thisLayer", "Stroke", 1, "box"));
        ensureTint(box, FILL_TINT, "thisLayer", "Fill");
        return ensureStrokeLayer(comp, box);
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
            if (isStrokeLayer(layer)) {
                // Selected along with its own box, it simply rides along.
                var withBox = layer.parent && (containsLayer(layers, layer.parent) || sameLayer(layer.parent, box));
                if (!withBox) skipped.push(layer.name + " — it draws a box's stroke; select its box instead");
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

    // Pin a layout-driven position at what it shows right now. Re-parenting
    // compensates the stored value, not the expression's result, so without
    // this a layer leaving a stack would jump back to its old spot.
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
        var top = topLevel(layers), i;
        for (i = 0; i < top.length; i++) freeze(comp, top[i]);
        for (i = 0; i < top.length; i++) {
            if (!sameLayer(top[i].parent, box)) top[i].parent = box;
        }
    }

    // Comp-space bounds of `layers` at the current time, via a temporary
    // expression (scripting has no toComp).
    function measure(comp, box, layers) {
        var ids = [];
        for (var i = 0; i < layers.length; i++) ids.push(layers[i].index);
        var code = [
            'var ids = [' + ids.join(", ") + '];',
            'var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;',
            'for (var i = 0; i < ids.length; i++) {',
            '  var L = thisComp.layer(ids[i]), ext = true;',
            '  try { ext = L.text.sourceText === undefined; } catch (err) { ext = true; }',
            '  var sr = L.sourceRectAtTime(time, ext);',
            '  var xs = [sr.left, sr.left + sr.width], ys = [sr.top, sr.top + sr.height];',
            '  for (var k = 0; k < 4; k++) {',
            '    var p = L.toComp([xs[k % 2], ys[Math.floor(k / 2)]]);',
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
    // Upgrading boxes made by AutoBox 1.x
    // ------------------------------------------------------------------
    var LEGACY_MEMBER_RE = /AB_M\.push\(thisComp\.layer\("((?:[^"\\]|\\.)*)"\)\)/g;

    function isLegacyBox(box) {
        if (rigParts(box).size.expression.indexOf("AB_M.push(") >= 0) return true;
        for (var i = 0; i < CONTROLS.length; i++) {
            if (!findControl(box, CONTROLS[i].name)) return true;
        }
        return false;
    }

    function controlColor(box, name, t) {
        var effect = findControl(box, name);
        if (!effect) return null;
        var c = effect.property(1).valueAtTime(t, false);
        return [c[0], c[1], c[2]];
    }

    // Give a 1.x box the 2.0 engine without changing how it looks: new
    // controls are seeded from the box's own colors, and members 1.x
    // tracked by name (without parenting them) are parented to the box.
    // Returns null if the box didn't need upgrading.
    function upgradeBox(comp, box) {
        if (!isLegacyBox(box)) return null;
        var t = comp.time, seed = copySettings(DEFAULTS), moved = [], m;
        var fill = controlColor(box, "Fill Color", t), stroke = controlColor(box, "Stroke Color", t);
        if (fill) seed.fillColor = seed.fillColor2 = fill;
        if (stroke) seed.strokeColor = seed.strokeColor2 = stroke;
        ensureControls(box, seed, t);

        var expr = rigParts(box).size.expression;
        LEGACY_MEMBER_RE.lastIndex = 0;
        while ((m = LEGACY_MEMBER_RE.exec(expr)) !== null) {
            var name = m[1].replace(/\\(.)/g, "$1"), layer = null;
            for (var i = 1; i <= comp.numLayers && !layer; i++) {
                if (comp.layer(i).name == name && comp.layer(i).index != box.index) layer = comp.layer(i);
            }
            if (!layer || layer.locked) continue;
            freeze(comp, layer);
            if (!isAncestor(box, layer)) {
                layer.parent = box;
                moved.push(layer.name);
            }
        }
        paintBox(comp, box);
        rigBox(comp, box);
        return { name: box.name, moved: moved };
    }

    // Layers whose position already has someone else's expression can't be
    // moved into a stack; say so instead of leaving a mystery gap.
    function reportBlocked(blocked) {
        if (!blocked.length) return;
        alert("These layers already have an expression on Position, so AutoBox won't move them in a stack:\n\n" +
            blocked.join("\n") + "\n\nRemove that expression and click Apply to Box.", SCRIPT_NAME);
    }

    function reportUpgrades(upgraded, more) {
        if (!upgraded.length) return;
        var lines = [];
        for (var i = 0; i < upgraded.length; i++) {
            lines.push(upgraded[i].name + (upgraded[i].moved.length ? " (now parented to it: " + upgraded[i].moved.join(", ") + ")" : ""));
        }
        alert("Upgraded to AutoBox " + VERSION + ", keeping their settings:\n\n" + lines.join("\n") + (more ? "\n\n" + more : ""), SCRIPT_NAME);
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
        if (!confirmCut(linksToCut(top, outer))) return;

        app.beginUndoGroup("AutoBox: Create Box");
        try {
            removeOrphanStrokeLayers(comp);
            var box = comp.layers.addShape();
            box.name = uniqueBoxName(comp, box);
            box.moveAfter(lowestLayer(members));
            fitTiming(box, members);
            var tr = box.property("ADBE Transform Group");
            tr.property("ADBE Anchor Point").setValue([0, 0]);
            tr.property("ADBE Position").setValue(anchorPoint(measure(comp, box, members), s));
            if (outer) {
                box.parent = outer;
                // Inside another box: sit above it (and its stroke) to show.
                var above = isBox(outer) ? (strokeLayerOf(comp, outer) || outer) : null;
                if (above && box.index > above.index) box.moveBefore(above);
            }

            addControls(box, s, comp.time);
            buildShape(box);
            paintBox(comp, box);
            adopt(comp, box, members);
            var blocked = [];
            rigBox(comp, box, blocked);
            if (outer && isBox(outer)) rigBox(comp, outer);

            deselectAll(comp);
            box.selected = true;
            checkRig(comp, box);
            reportBlocked(blocked);
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

        app.beginUndoGroup("AutoBox: Add to Box");
        try {
            removeOrphanStrokeLayers(comp);
            var upgraded = upgradeBox(comp, box);
            adopt(comp, box, added);
            var blocked = [];
            var members = rigBox(comp, box, blocked);
            var lowest = lowestLayer(members.concat(added));
            if (lowest.index > box.index) box.moveAfter(lowest);
            fitTiming(box, members.concat(added));
            paintBox(comp, box);
            checkRig(comp, box);
            if (upgraded) reportUpgrades([upgraded]);
            reportBlocked(blocked);
        } finally {
            app.endUndoGroup();
        }
    }

    function removeFromBox() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, picked = [], i;
        for (i = 0; i < sel.length; i++) {
            if (isStrokeLayer(sel[i])) continue;
            if (ownerBox(sel[i]) || hasRigExpression(sel[i])) picked.push(sel[i]);
        }
        if (!picked.length) {
            alert("Select the layers you want to take out of their box.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: Remove from Box");
        try {
            // Bake everything first: unparenting one layer can change the
            // layout of the others.
            for (i = 0; i < picked.length; i++) releaseMember(comp, picked[i]);
            for (i = 0; i < picked.length; i++) picked[i].parent = null;
        } finally {
            app.endUndoGroup();
        }
    }

    // Push the panel's settings onto the selected boxes. Controls you have
    // animated are left alone. Boxes from AutoBox 1.x are only upgraded the
    // first time, so their own settings survive.
    function applySettings(s) {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), upgraded = [], blocked = [];
        if (!boxes.length) return;
        app.beginUndoGroup("AutoBox: Apply Settings");
        try {
            removeOrphanStrokeLayers(comp);
            for (var i = 0; i < boxes.length; i++) {
                var up = upgradeBox(comp, boxes[i]);
                if (up) {
                    upgraded.push(up);
                    continue;
                }
                setControls(boxes[i], s, null, comp.time, true);
                paintBox(comp, boxes[i]);
                rigBox(comp, boxes[i], blocked);
            }
            reportUpgrades(upgraded, "Click Apply to Box again to apply the panel's settings to them.");
            reportBlocked(blocked);
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

    function releaseBoxes() {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), i, j;
        if (!boxes.length) return;
        if (!confirm("Release " + boxes.length + " box(es)?\n\nThe current layout is baked into plain " +
                "values/keyframes and the layers stop updating automatically.", false, SCRIPT_NAME)) return;

        app.beginUndoGroup("AutoBox: Release");
        try {
            for (i = 0; i < boxes.length; i++) upgradeBox(comp, boxes[i]);
            // Bake every box before removing any controls: a nested box's
            // layout depends on its outer box and the other way round.
            for (i = 0; i < boxes.length; i++) {
                var box = boxes[i], members = directMembers(comp, box);
                for (j = 0; j < members.length; j++) releaseMember(comp, members[j]);
                var parts = rigParts(box), range = layerTimeRange(comp, box);
                bakeProperty(comp, parts.size, range);
                bakeProperty(comp, parts.position, range);
                bakeProperty(comp, parts.roundness, range);
            }
            for (i = 0; i < boxes.length; i++) {
                for (j = CONTROLS.length - 1; j >= 0; j--) {
                    if (CONTROLS[j].keep) continue;
                    var effect = findControl(boxes[i], CONTROLS[j].name);
                    if (effect) effect.remove();
                }
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
            "scaling or rotating the box moves the whole group.",
            "",
            "Any layer parented to a box is in that box, so editing text, renaming, reordering",
            "or duplicating layers is safe. Use Add to Box / Remove to change what's in a box",
            "(after pick-whipping a layer into a stack, click Apply to Box).",
            "",
            "LAYOUT",
            "  Free — layers stay where you put them; the box wraps around them.",
            "  Vertical / Horizontal — layers are stacked in timeline order (top layer first)",
            "  with Gap between them. Reorder layers in the timeline to reorder the stack.",
            "  Align — cross-axis alignment. Justify — main-axis placement when the box is",
            "  bigger than its contents (Min Width / Min Height).",
            "  Box Anchor — the point of the box that stays put as it grows.",
            "",
            "FILL / STROKE — solid colors or linear / radial gradients that stretch with the box.",
            "",
            "Everything updates live and lives on the box layer's Effect Controls, where it can be",
            "keyframed. Panel values are the defaults for new boxes; Apply to Box pushes them onto",
            "the selected boxes (keyframed controls are left alone).",
            "",
            "ADD TO BOX — select a box and other layers. REMOVE — select layers in a box.",
            "RELEASE — bakes the current layout to plain values/keyframes and removes the rig.",
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
        function slider(parent, label, key, lo, hi, tip, min, max) {
            var g = row(parent, label);
            var sl = g.add("slider", undefined, clampValue(s[key], lo, hi), lo, hi);
            sl.alignment = ["fill", "center"];
            sl.preferredSize.width = 110;
            sl.helpTip = tip;
            var e = number(g, key, tip, 4, min, max);
            e.slider = sl;
            sl.onChanging = sl.onChange = function () {
                s[key] = Math.round(this.value);
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

        // Fill / Stroke tab body: type, color(s), angle, opacity.
        function paintTab(t, prefix, name) {
            var r = row(t, "Type");
            dropdown(r, prefix + "Type", PAINT_TYPES, name + ": a solid color or a gradient that stretches with the box");
            r = row(t, "Colors");
            swatch(r, prefix + "Color", name + " color (gradient start)");
            swatch(r, prefix + "Color2", "Gradient end color");
            slider(t, "Angle", prefix + "Angle", 0, 360, "Linear gradient direction in degrees (0 = up, 90 = right)");
            slider(t, "Opacity", prefix + "Opacity", 0, 100, name + " opacity (%)", 0, 100);
        }

        var tabs = win.add("tabbedpanel");
        tabs.alignChildren = ["fill", "top"];

        var t = tab(tabs, "Layout");
        var r = row(t, "Mode");
        dropdown(r, "layout", LAYOUTS,
            "Free keeps layers where they are and wraps the box around them. Vertical / Horizontal stack them.");
        slider(t, "Gap", "gap", 0, 100, "Space between stacked layers (px)");
        r = row(t, "Align");
        dropdown(r, "align", ALIGNS,
            "Cross-axis alignment: left/center/right in a vertical stack, top/center/bottom in a horizontal one");
        r = row(t, "Justify");
        dropdown(r, "justify", JUSTIFIES,
            "Where the stack sits along its main axis when the box is bigger than its contents (Min Width / Height)");
        r = row(t, "Anchor");
        dropdown(r, "anchor", ANCHORS, "The point of the box that stays put while it grows or shrinks");

        t = tab(tabs, "Box");
        slider(t, "Padding", "padding", 0, 200, "Space between the layers and the edge of the box on every side (px)");
        slider(t, "Radius", "radius", 0, 200, "Corner radius (px)", 0);
        r = row(t, "Extra");
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
        var hidden = t.add("checkbox", undefined, "Ignore hidden layers");
        hidden.value = s.ignoreHidden > 0;
        hidden.helpTip = "Layers that are switched off or outside their in/out points don't take up space";
        hidden.onClick = function () {
            s.ignoreHidden = this.value ? 1 : 0;
            persist();
        };

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
        button(g, "Release", releaseBoxes, "Bake the layout and remove the AutoBox rig from the selected box(es)");
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
            buildExpression: buildExpression,
            CONTROLS: CONTROLS,
            DEFAULTS: DEFAULTS,
            createBox: createBox,
            addToBox: addToBox,
            removeFromBox: removeFromBox,
            applySettings: applySettings,
            selectMembers: selectMembers,
            releaseBoxes: releaseBoxes,
            buildUI: buildUI
        };
        return;
    }

    buildUI(thisObj);
})(this);
