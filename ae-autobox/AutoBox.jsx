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
    var VERSION = "1.0.0";
    var SETTINGS_SECTION = "BraisedAutoBox";
    var RIG_GROUP = "AutoBox";
    var RECT_NAME = "Box Rect";
    var EXPR_TAG = "// AutoBox";

    var LAYOUTS = ["Free (wrap)", "Vertical Stack", "Horizontal Stack"];
    var ALIGNS = ["Start (Left/Top)", "Center", "End (Right/Bottom)"];
    var JUSTIFIES = ["Start", "Center", "End", "Space Between"];
    var ANCHORS = ["Top Left", "Top", "Top Right", "Left", "Center", "Right", "Bottom Left", "Bottom", "Bottom Right"];

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
        { key: "fillColor", name: "Fill Color", type: "color", keep: true },
        { key: "fillOpacity", name: "Fill Opacity", type: "slider", keep: true },
        { key: "strokeWidth", name: "Stroke Width", type: "slider", keep: true },
        { key: "strokeColor", name: "Stroke Color", type: "color", keep: true },
        { key: "ignoreHidden", name: "Ignore Hidden", type: "checkbox" }
    ];

    var CONTROL_MATCH = {
        slider: "ADBE Slider Control",
        color: "ADBE Color Control",
        checkbox: "ADBE Checkbox Control",
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
        fillColor: [27 / 255, 54 / 255, 67 / 255],
        fillOpacity: 100,
        strokeWidth: 0,
        strokeColor: [0, 166 / 255, 105 / 255],
        ignoreHidden: 1
    };

    // ------------------------------------------------------------------
    // Expression engine
    //
    // Every rigged property gets the same engine, preceded by a header that
    // names the box (AB_BOX) and its members (AB_M). Layers are referenced
    // as thisComp.layer("Name") so After Effects keeps the expressions up to
    // date when layers are renamed. Written in ES3 so it runs on the Legacy
    // ExtendScript engine as well as the JavaScript engine.
    // ------------------------------------------------------------------
    var ENGINE = [
        'var AB_T = time;',
        'function ab_ctl(n, d) { try { return AB_BOX.effect(n)(1).value; } catch (err) { return d; } }',
        'var AB_MODE = Math.round(ab_ctl("Layout", 1));',
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
        // Is L one of this box's members?
        'function ab_isMember(L) {',
        '  for (var i = 0; i < AB_M.length; i++) { if (AB_M[i].index == L.index) return true; }',
        '  return false;',
        '}',
        // A member parented (directly or not) to another member rides along
        // with it instead of taking its own slot in a stack.
        'function ab_rides(L) {',
        '  for (var g = 0; g < 50 && L.hasParent; g++) {',
        '    L = L.parent;',
        '    if (L.index == AB_BOX.index) return false;',
        '    if (ab_isMember(L)) return true;',
        '  }',
        '  return false;',
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
        'function ab_metrics(L, ext) {',
        '  var sr = L.sourceRectAtTime(AB_T, ext);',
        '  var a = L.transform.anchorPoint.value, s = L.transform.scale.value;',
        '  var x0 = (sr.left - a[0]) * s[0] / 100, x1 = (sr.left + sr.width - a[0]) * s[0] / 100;',
        '  var y0 = (sr.top - a[1]) * s[1] / 100, y1 = (sr.top + sr.height - a[1]) * s[1] / 100;',
        '  return { idx: L.index, ox: Math.min(x0, x1), oy: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };',
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
        '  var i, k, L;',
        '  if (AB_MODE != 2 && AB_MODE != 3) {',
        '    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;',
        '    for (i = 0; i < AB_M.length; i++) {',
        '      L = AB_M[i];',
        '      if (AB_SKIP && !L.active) continue;',
        '      var sr = L.sourceRectAtTime(AB_T, AB_MX[i]);',
        '      var xs = [sr.left, sr.left + sr.width], ys = [sr.top, sr.top + sr.height];',
        '      for (k = 0; k < 4; k++) {',
        '        var p = ab_toBox(L, xs[k % 2], ys[Math.floor(k / 2)]);',
        '        l = Math.min(l, p[0]); t = Math.min(t, p[1]); r = Math.max(r, p[0]); b = Math.max(b, p[1]);',
        '      }',
        '    }',
        '    if (l > r) return res;',
        '    var gx = ab_grow(l - AB_PL, r + AB_PR, AB_MINW, ax), gy = ab_grow(t - AB_PT, b + AB_PB, AB_MINH, ay);',
        '    res.l = gx[0]; res.r = gx[1]; res.t = gy[0]; res.b = gy[1];',
        '    return res;',
        '  }',
        '  var vert = AB_MODE == 2, items = [];',
        '  for (i = 0; i < AB_M.length; i++) {',
        '    L = AB_M[i];',
        '    if ((AB_SKIP && !L.active) || ab_rides(L)) continue;',
        '    items.push(ab_metrics(L, AB_MX[i]));',
        '  }',
        '  if (!items.length) return res;',
        '  items.sort(function (p, q) { return p.idx - q.idx; });',
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
        '  for (i = 0; i < n; i++) {',
        '    var m = items[i], sMain = vert ? m.h : m.w, sCross = vert ? m.w : m.h, off = 0;',
        '    if (AB_ALIGN == 2) off = (innerCross - sCross) / 2;',
        '    else if (AB_ALIGN == 3) off = innerCross - sCross;',
        '    res.pos[m.idx] = vert ? [il + off, it + cursor] : [il + cursor, it + off];',
        '    res.m[m.idx] = m;',
        '    cursor += sMain + gap;',
        '  }',
        '  return res;',
        '}'
    ].join("\n");

    var MEMBER_TAIL = [
        'var ab_out = value;',
        'if (AB_BOX && (AB_MODE == 2 || AB_MODE == 3)) {',
        '  var ab_r = ab_solve(), ab_tl = ab_r.pos[thisLayer.index], ab_mm = ab_r.m[thisLayer.index];',
        '  if (ab_tl) {',
        '    var ab_p = ab_tl;',
        '    if (!(thisLayer.hasParent && thisLayer.parent.index == AB_BOX.index)) {',
        '      ab_p = AB_BOX.toComp(ab_tl);',
        '      if (thisLayer.hasParent) ab_p = thisLayer.parent.fromComp(ab_p);',
        '    }',
        '    var ab_x = ab_p[0] - ab_mm.ox, ab_y = ab_p[1] - ab_mm.oy;',
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

    // Fill / stroke follow the box's own Effect Controls.
    var STYLE_EXPRESSIONS = {
        fillColor: 'var c = value; try { c = effect("Fill Color")(1).value; } catch (err) {} c;',
        fillOpacity: 'var c = value; try { c = effect("Fill Opacity")(1).value; } catch (err) {} c;',
        strokeColor: 'var c = value; try { c = effect("Stroke Color")(1).value; } catch (err) {} c;',
        strokeWidth: 'var c = value; try { c = effect("Stroke Width")(1).value; } catch (err) {} c;',
        strokeOpacity: 'var c = 0; try { c = effect("Stroke Width")(1).value > 0 ? 100 : 0; } catch (err) {} c;'
    };

    var MEMBER_RE = /AB_M\.push\(thisComp\.layer\("((?:[^"\\]|\\.)*)"\)\)/g;
    var BOX_RE = /AB_BOX = thisComp\.layer\("((?:[^"\\]|\\.)*)"\);/;

    function quote(s) {
        return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
    }

    function unquote(s) {
        return s.replace(/\\(.)/g, "$1");
    }

    // kind: size | position | roundness (box) or member | memberX | memberY.
    // members: [{ name: String, ext: Boolean }] — ext includes stroke extents.
    function buildExpression(kind, boxName, members) {
        var lines = [];
        if (kind.indexOf("member") === 0) {
            lines.push(EXPR_TAG + " member: position is laid out by the box layer. Remove it with the AutoBox panel.");
            // If the box is deleted the member falls back to its own position.
            lines.push("var AB_BOX = null; try { AB_BOX = thisComp.layer(" + quote(boxName) + "); } catch (err) {}");
        } else {
            lines.push(EXPR_TAG + " box: sized from its member layers. Change it in Effect Controls.");
            lines.push("var AB_BOX = thisLayer;");
        }
        lines.push("var AB_M = [], AB_MX = [];");
        for (var i = 0; i < members.length; i++) {
            lines.push("try { AB_M.push(thisComp.layer(" + quote(members[i].name) + ")); AB_MX.push(" +
                (members[i].ext ? "true" : "false") + "); } catch (err) {}");
        }
        lines.push(ENGINE);
        lines.push(TAILS[kind]);
        return lines.join("\n");
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

    function rigGroup(layer) {
        if (!(layer instanceof ShapeLayer)) return null;
        try {
            return layer.property("ADBE Root Vectors Group").property(RIG_GROUP) || null;
        } catch (err) {
            return null;
        }
    }

    function isBox(layer) {
        return rigGroup(layer) !== null;
    }

    function rigParts(box) {
        var group = rigGroup(box);
        var contents = group.property("ADBE Vectors Group");
        var rect = contents.property("ADBE Vector Shape - Rect");
        return {
            group: group,
            size: rect.property("ADBE Vector Rect Size"),
            position: rect.property("ADBE Vector Rect Position"),
            roundness: rect.property("ADBE Vector Rect Roundness"),
            fill: contents.property("ADBE Vector Graphic - Fill"),
            stroke: contents.property("ADBE Vector Graphic - Stroke")
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

    // Name of the box that lays out this layer, or null.
    function memberBoxName(layer) {
        var props = positionProps(layer);
        for (var i = 0; i < props.length; i++) {
            if (isRigExpression(props[i])) {
                var m = BOX_RE.exec(props[i].expression);
                if (m) return unquote(m[1]);
            }
        }
        return null;
    }

    function findLayer(comp, name) {
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i).name == name) return comp.layer(i);
        }
        return null;
    }

    function readMembers(comp, box) {
        var expr = rigParts(box).size.expression, out = [], seen = {}, m;
        MEMBER_RE.lastIndex = 0;
        while ((m = MEMBER_RE.exec(expr)) !== null) {
            var layer = findLayer(comp, unquote(m[1]));
            if (layer && !seen[layer.index]) {
                seen[layer.index] = true;
                out.push(layer);
            }
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

    function cleanName(name) {
        var s = String(name).replace(/[\r\n\u0003]+/g, " ").replace(/^\s+|\s+$/g, "");
        if (s.length > 40) s = s.substring(0, 40).replace(/\s+$/, "");
        return s || "Layer";
    }

    function nameTaken(comp, name, self) {
        for (var i = 1; i <= comp.numLayers; i++) {
            var other = comp.layer(i);
            if (other.index != self.index && other.name == name) return true;
        }
        return false;
    }

    // Expressions find members by name, so every member needs a unique,
    // explicit name (text layers otherwise rename themselves as you type).
    function makeNamesUnique(comp, layers) {
        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i], base = cleanName(layer.name), name = base, n = 2;
            while (nameTaken(comp, name, layer)) name = base + " " + (n++);
            if (name != layer.name || layer.isNameSet === false) layer.name = name;
        }
    }

    function uniqueBoxName(comp, box) {
        var n = 1;
        while (nameTaken(comp, "AutoBox " + n, box)) n++;
        return "AutoBox " + n;
    }

    function describe(members) {
        var out = [];
        for (var i = 0; i < members.length; i++) {
            out.push({ name: members[i].name, ext: members[i] instanceof ShapeLayer });
        }
        return out;
    }

    function setExpression(prop, expr) {
        prop.expression = expr;
        try { prop.expressionEnabled = true; } catch (err) {}
    }

    function setBoxExpressions(box, desc) {
        var parts = rigParts(box);
        setExpression(parts.size, buildExpression("size", null, desc));
        setExpression(parts.position, buildExpression("position", null, desc));
        setExpression(parts.roundness, buildExpression("roundness", null, desc));
    }

    function setMemberExpressions(box, members, desc) {
        for (var i = 0; i < members.length; i++) {
            var props = positionProps(members[i]);
            if (props.length == 1) {
                setExpression(props[0], buildExpression("member", box.name, desc));
            } else {
                setExpression(props[0], buildExpression("memberX", box.name, desc));
                setExpression(props[1], buildExpression("memberY", box.name, desc));
            }
        }
    }

    function applyRig(box, members) {
        var desc = describe(members);
        setBoxExpressions(box, desc);
        setMemberExpressions(box, members, desc);
    }

    // Evaluate rigged properties and report any expression errors.
    function checkRig(comp, box, members) {
        var props = [], errors = [], i, j;
        var parts = rigParts(box);
        props.push([box.name, parts.size], [box.name, parts.position], [box.name, parts.roundness]);
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

    // Bake and clear the layout expression(s) this box put on a member.
    function releaseMember(comp, member, boxName) {
        if (memberBoxName(member) !== boxName) return;
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

    function setControls(box, values, keys, t) {
        for (var i = 0; i < CONTROLS.length; i++) {
            var c = CONTROLS[i];
            if (keys && !keys[c.key]) continue;
            var effect = findControl(box, c.name);
            if (effect) writeControl(effect.property(1), c, values[c.key], t);
        }
    }

    function buildShape(box) {
        var root = box.property("ADBE Root Vectors Group");
        var group = root.addProperty("ADBE Vector Group");
        group.name = RIG_GROUP;
        var contents = group.property("ADBE Vectors Group");
        contents.addProperty("ADBE Vector Shape - Rect").name = RECT_NAME;
        contents.addProperty("ADBE Vector Graphic - Stroke");
        contents.addProperty("ADBE Vector Graphic - Fill");

        var parts = rigParts(box);
        setExpression(parts.fill.property("ADBE Vector Fill Color"), STYLE_EXPRESSIONS.fillColor);
        setExpression(parts.fill.property("ADBE Vector Fill Opacity"), STYLE_EXPRESSIONS.fillOpacity);
        setExpression(parts.stroke.property("ADBE Vector Stroke Color"), STYLE_EXPRESSIONS.strokeColor);
        setExpression(parts.stroke.property("ADBE Vector Stroke Width"), STYLE_EXPRESSIONS.strokeWidth);
        setExpression(parts.stroke.property("ADBE Vector Stroke Opacity"), STYLE_EXPRESSIONS.strokeOpacity);
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
            if (!isUsable(layer)) {
                skipped.push(layer.name + " — cameras, lights, nulls, adjustment and audio layers can't be boxed");
                continue;
            }
            if (layer.locked) {
                skipped.push(layer.name + " — layer is locked");
                continue;
            }
            var owner = memberBoxName(layer);
            if (owner !== null && (!box || owner != box.name)) {
                skipped.push(layer.name + " — already in " + owner + " (remove it from that box first)");
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

        app.beginUndoGroup("AutoBox: Create Box");
        try {
            makeNamesUnique(comp, members);

            var box = comp.layers.addShape();
            box.name = uniqueBoxName(comp, box);
            box.moveAfter(lowestLayer(members));
            fitTiming(box, members);
            var tr = box.property("ADBE Transform Group");
            tr.property("ADBE Anchor Point").setValue([0, 0]);
            tr.property("ADBE Position").setValue([0, 0]);

            // Measure in Free mode with every member counted, so the box
            // layer's position can sit on the chosen anchor of the current
            // selection and nothing jumps when the layers are parented.
            var init = copySettings(s);
            init.layout = 1;
            init.ignoreHidden = 0;
            addControls(box, init, comp.time);
            buildShape(box);
            var desc = describe(members);
            setBoxExpressions(box, desc);

            var parts = rigParts(box);
            var size = parts.size.valueAtTime(comp.time, false);
            var center = parts.position.valueAtTime(comp.time, false);
            var anchor = Math.max(0, Math.min(8, Math.round(s.anchor) - 1));
            box.property("ADBE Transform Group").property("ADBE Position").setValue([
                center[0] - size[0] / 2 + size[0] * (anchor % 3) / 2,
                center[1] - size[1] / 2 + size[1] * Math.floor(anchor / 3) / 2
            ]);

            for (var i = 0; i < members.length; i++) {
                if (!members[i].parent) members[i].parent = box;
            }
            setMemberExpressions(box, members, desc);
            setControls(box, s, { layout: true, ignoreHidden: true }, comp.time);

            for (var j = 1; j <= comp.numLayers; j++) comp.layer(j).selected = false;
            box.selected = true;
            checkRig(comp, box, members);
        } finally {
            app.endUndoGroup();
        }
    }

    // Boxes the current selection points at: selected box layers, plus the
    // boxes of any selected members.
    function selectedBoxes(comp) {
        var sel = comp.selectedLayers, out = [];
        for (var i = 0; i < sel.length; i++) {
            var box = null;
            if (isBox(sel[i])) {
                box = sel[i];
            } else {
                var name = memberBoxName(sel[i]);
                if (name !== null) box = findLayer(comp, name);
            }
            if (box && isBox(box) && !containsLayer(out, box)) out.push(box);
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
        var members = readMembers(comp, box), added = [];
        var picked = pickMembers(sel, box);
        for (i = 0; i < picked.length; i++) {
            if (!containsLayer(members, picked[i])) added.push(picked[i]);
        }
        if (!added.length) return;

        app.beginUndoGroup("AutoBox: Add to Box");
        try {
            makeNamesUnique(comp, added);
            for (i = 0; i < added.length; i++) {
                if (!added[i].parent) added[i].parent = box;
            }
            members = members.concat(added);
            applyRig(box, members);
            var lowest = lowestLayer(members);
            if (lowest.index > box.index) box.moveAfter(lowest);
            fitTiming(box, members);
            checkRig(comp, box, members);
        } finally {
            app.endUndoGroup();
        }
    }

    function removeFromBox() {
        var comp = activeComp();
        if (!comp) return;
        var sel = comp.selectedLayers, groups = [], i, j;
        for (i = 0; i < sel.length; i++) {
            var name = memberBoxName(sel[i]);
            if (name === null) continue;
            for (j = 0; j < groups.length && groups[j].name != name; j++) {}
            if (j == groups.length) groups.push({ name: name, layers: [] });
            groups[j].layers.push(sel[i]);
        }
        if (!groups.length) {
            alert("Select the layers you want to take out of their box.", SCRIPT_NAME);
            return;
        }

        app.beginUndoGroup("AutoBox: Remove from Box");
        try {
            for (i = 0; i < groups.length; i++) {
                var g = groups[i], box = findLayer(comp, g.name);
                for (j = 0; j < g.layers.length; j++) {
                    releaseMember(comp, g.layers[j], g.name);
                    if (box && g.layers[j].parent && g.layers[j].parent.index == box.index) g.layers[j].parent = null;
                }
                if (box && isBox(box)) {
                    var keep = [], members = readMembers(comp, box);
                    for (j = 0; j < members.length; j++) {
                        if (!containsLayer(g.layers, members[j])) keep.push(members[j]);
                    }
                    applyRig(box, keep);
                }
            }
        } finally {
            app.endUndoGroup();
        }
    }

    function applySettings(s) {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp);
        if (!boxes.length) return;
        app.beginUndoGroup("AutoBox: Apply Settings");
        try {
            for (var i = 0; i < boxes.length; i++) setControls(boxes[i], s, null, comp.time);
        } finally {
            app.endUndoGroup();
        }
    }

    function selectMembers() {
        var comp = activeComp();
        if (!comp) return;
        var boxes = selectedBoxes(comp), i, j;
        if (!boxes.length) return;
        for (i = 1; i <= comp.numLayers; i++) comp.layer(i).selected = false;
        for (i = 0; i < boxes.length; i++) {
            var members = readMembers(comp, boxes[i]);
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
            for (i = 0; i < boxes.length; i++) {
                var box = boxes[i], members = readMembers(comp, box);
                for (j = 0; j < members.length; j++) releaseMember(comp, members[j], box.name);
                var parts = rigParts(box), range = layerTimeRange(comp, box);
                bakeProperty(comp, parts.size, range);
                bakeProperty(comp, parts.position, range);
                bakeProperty(comp, parts.roundness, range);
                for (j = CONTROLS.length - 1; j >= 0; j--) {
                    if (CONTROLS[j].keep) continue;
                    var effect = findControl(box, CONTROLS[j].name);
                    if (effect) effect.remove();
                }
                rigParts(box).group.name = "Box";
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
            "fit with padding and rounded corners. The layers are parented to it, so moving,",
            "scaling or rotating the box moves the whole group.",
            "",
            "LAYOUT",
            "  Free — layers stay where you put them; the box wraps around them.",
            "  Vertical / Horizontal — layers are stacked in timeline order (top layer first)",
            "  with Gap between them. Reorder layers in the timeline to reorder the stack.",
            "  Align — cross-axis alignment. Justify — main-axis placement when the box is",
            "  bigger than its contents (Min Width / Min Height).",
            "  Box Anchor — the point of the box that stays put as it grows.",
            "",
            "Everything updates live: edit text, scale a layer or animate it and the box and",
            "stack follow. All settings live on the box layer's Effect Controls and can be keyframed.",
            "Panel values are the defaults for new boxes; Apply to Box pushes them to selected boxes.",
            "",
            "ADD TO BOX — select a box and other layers. REMOVE — select layers in a box.",
            "RELEASE — bakes the current layout to plain values/keyframes and removes the rig.",
            "SELECT MEMBERS — selects every layer in the selected box.",
            "",
            "Tips: hidden layers (eye off or outside their in/out) leave the layout when",
            "Ignore Hidden is on. A layer parented to another member rides along with it.",
            "A box can be a member of another box for nested layouts."
        ].join("\n"), SCRIPT_NAME);
    }

    // ------------------------------------------------------------------
    // UI
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

        function section(title) {
            var p = win.add("panel", undefined, title);
            p.orientation = "column";
            p.alignChildren = ["fill", "top"];
            p.spacing = 4;
            p.margins = [8, 14, 8, 8];
            return p;
        }

        function row(parent, label) {
            var g = parent.add("group");
            g.orientation = "row";
            g.alignChildren = ["left", "center"];
            g.spacing = 4;
            if (label !== undefined) g.add("statictext", undefined, label).preferredSize.width = 58;
            return g;
        }

        function text(parent, label) {
            return parent.add("statictext", undefined, label);
        }

        function number(parent, key, tip, chars) {
            var e = parent.add("edittext", undefined, String(s[key]));
            e.characters = chars || 4;
            e.helpTip = tip;
            e.onChange = function () {
                var v = parseFloat(this.text);
                if (isNaN(v)) {
                    this.text = String(s[key]);
                    return;
                }
                s[key] = v;
                this.text = String(v);
                persist();
            };
            return e;
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

        var layout = section("Layout");
        dropdown(row(layout, "Mode"), "layout", LAYOUTS,
            "Free keeps layers where they are and wraps the box around them. Vertical / Horizontal stack them.");
        number(row(layout, "Gap"), "gap", "Space between stacked layers (px)");
        dropdown(row(layout, "Align"), "align", ALIGNS,
            "Cross-axis alignment: left/center/right in a vertical stack, top/center/bottom in a horizontal one");
        dropdown(row(layout, "Justify"), "justify", JUSTIFIES,
            "Where the stack sits along its main axis when the box is bigger than its contents (Min Width / Height)");
        dropdown(row(layout, "Anchor"), "anchor", ANCHORS,
            "The point of the box that stays put while it grows or shrinks");

        var boxPanel = section("Box");
        var r = row(boxPanel, "Padding");
        number(r, "padding", "Space between the layers and the edge of the box on every side (px)");
        text(r, "Radius");
        number(r, "radius", "Corner radius (px)");
        r = row(boxPanel, "Extra");
        text(r, "T");
        number(r, "extraTop", "Extra padding on top (px), added to Padding", 3);
        text(r, "R");
        number(r, "extraRight", "Extra padding on the right (px), added to Padding", 3);
        text(r, "B");
        number(r, "extraBottom", "Extra padding at the bottom (px), added to Padding", 3);
        text(r, "L");
        number(r, "extraLeft", "Extra padding on the left (px), added to Padding", 3);
        r = row(boxPanel, "Min size");
        text(r, "W");
        number(r, "minWidth", "Minimum box width (px), 0 = fit contents");
        text(r, "H");
        number(r, "minHeight", "Minimum box height (px), 0 = fit contents");
        r = row(boxPanel, "Fill");
        swatch(r, "fillColor", "Fill color");
        number(r, "fillOpacity", "Fill opacity (%)");
        text(r, "%");
        r = row(boxPanel, "Stroke");
        swatch(r, "strokeColor", "Stroke color");
        number(r, "strokeWidth", "Stroke width (px), 0 = no stroke");
        text(r, "px");
        var hidden = boxPanel.add("checkbox", undefined, "Ignore hidden layers");
        hidden.value = s.ignoreHidden > 0;
        hidden.helpTip = "Layers that are switched off or outside their in/out points don't take up space";
        hidden.onClick = function () {
            s.ignoreHidden = this.value ? 1 : 0;
            persist();
        };

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
