/*
 * Property Linker v1.0 - Braised Animation
 * ExtendScript side of the Property Linker panel.
 *
 * Links the same property on many layers to one expression control
 * (Slider, Angle, Point or Color Control) that lives on a new control null.
 * The null is only a holder for the control - nothing is parented to it.
 *
 * The panel calls:
 *   PropertyLinker.link(choice, relative, addToSelectedNull, overwrite)
 * and gets back a JSON string describing what happened.
 *
 * ExtendScript is ES3: no Array.indexOf/map/forEach, JSON or String.trim.
 * Keep this file ASCII-only.
 */

(function (root) {

    var VERSION = "1.0.0";
    var UNDO_NAME = "Property Linker";
    var NULL_SUFFIX = " Control";

    var CHOICES = {
        opacity:  { id: "opacity",  label: "Opacity",  matchName: "ADBE Opacity" },
        rotation: { id: "rotation", label: "Rotation", matchName: "ADBE Rotate Z" },
        scale:    { id: "scale",    label: "Scale",    matchName: "ADBE Scale" },
        position: { id: "position", label: "Position", matchName: "ADBE Position" },
        selected: { id: "selected", label: "Selected Properties", matchName: null }
    };

    // Expression control effects. dims = size of the control's value.
    var CONTROLS = {
        slider:  { matchName: "ADBE Slider Control",  label: "Slider Control",   dims: 1 },
        angle:   { matchName: "ADBE Angle Control",   label: "Angle Control",    dims: 1 },
        point:   { matchName: "ADBE Point Control",   label: "Point Control",    dims: 2 },
        point3d: { matchName: "ADBE Point3D Control", label: "3D Point Control", dims: 3 },
        color:   { matchName: "ADBE Color Control",   label: "Color Control",    dims: 4 }
    };

    var PERCENT_MATCHNAMES = { "ADBE Opacity": true, "ADBE Scale": true };
    var DEGREE_MATCHNAMES = { "ADBE Rotate X": true, "ADBE Rotate Y": true, "ADBE Rotate Z": true, "ADBE Orientation": true };


    // =====================================================================
    // Small helpers
    // =====================================================================

    function userError(message) {
        var err = new Error(message);
        err.isUserError = true;
        return err;
    }

    function quoted(name) {
        return "\"" + name + "\"";
    }

    function plural(n, one, many) {
        return n + " " + (n === 1 ? one : many);
    }

    function is3D(layer) {
        try {
            if (layer.threeDLayer) return true;
        } catch (e) {}
        try {
            if (layer instanceof CameraLayer || layer instanceof LightLayer) return true;
        } catch (e2) {}
        return false;
    }

    function isSeparated(prop) {
        try {
            return prop.dimensionsSeparated === true;
        } catch (e) {
            return false;
        }
    }

    function filled(n, x) {
        var out = [];
        for (var i = 0; i < n; i++) out.push(x);
        return out;
    }

    // Copy the first `dims` values of v, padding with `pad`.
    function fitArray(v, dims, pad) {
        var out = [];
        for (var i = 0; i < dims; i++) out.push(i < v.length ? v[i] : pad);
        return out;
    }

    // A string literal for use inside an expression.
    function exprString(s) {
        return "\"" + String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
    }

    function valueNow(prop, comp) {
        return prop.valueAtTime(comp.time, false);
    }

    function describeTarget(t) {
        return quoted(t.layer.name) + " " + t.prop.name;
    }

    function quoteJSON(s) {
        return "\"" + String(s).replace(/[\\"\u0000-\u001f\u2028\u2029]/g, function (c) {
            if (c === "\"") return "\\\"";
            if (c === "\\") return "\\\\";
            if (c === "\n") return "\\n";
            if (c === "\r") return "\\r";
            if (c === "\t") return "\\t";
            var hex = c.charCodeAt(0).toString(16);
            return "\\u" + "0000".substring(hex.length) + hex;
        }) + "\"";
    }

    function toJSON(v) {
        if (v === null || v === undefined) return "null";
        var type = typeof v;
        if (type === "number") return isFinite(v) ? String(v) : "null";
        if (type === "boolean") return v ? "true" : "false";
        if (type === "string") return quoteJSON(v);
        var parts = [];
        if (v instanceof Array) {
            for (var i = 0; i < v.length; i++) parts.push(toJSON(v[i]));
            return "[" + parts.join(",") + "]";
        }
        for (var key in v) {
            if (v.hasOwnProperty(key)) parts.push(quoteJSON(key) + ":" + toJSON(v[key]));
        }
        return "{" + parts.join(",") + "}";
    }


    // =====================================================================
    // Finding what to link
    //
    // A "target" is one property that will get an expression:
    //   kind        scalar | scale | vector | color
    //   dims        how many values the property's expression returns
    //   component   >= 0 when the target is one dimension of a point control
    //               (Position with Separate Dimensions turned on)
    //   value       current value (Absolute controls start from it)
    //   vectorValue for separated dimensions: the layer's whole position
    // =====================================================================

    function newTarget(prop, layer) {
        return {
            prop: prop,
            layer: layer,
            label: prop.name,
            kind: "scalar",
            dims: 1,
            percent: false,
            degrees: false,
            component: -1,
            value: null,
            vectorValue: null,
            vectorDims: 0,
            order: 0
        };
    }

    // Targets on one layer for a property picked from the menu.
    function targetsForChoice(layer, choice, comp, warnings) {
        var xf = null;
        try {
            xf = layer.property("ADBE Transform Group");
        } catch (e) {}
        var prop = xf ? xf.property(choice.matchName) : null;
        if (!prop) {
            warnings.push(quoted(layer.name) + " has no " + choice.label + " - skipped.");
            return [];
        }

        var t;
        var dims = is3D(layer) ? 3 : 2;

        if (choice.id === "opacity" || choice.id === "rotation") {
            t = newTarget(prop, layer);
            t.percent = choice.id === "opacity";
            t.degrees = choice.id === "rotation";
            t.value = valueNow(prop, comp);
            return [t];
        }

        if (choice.id === "scale") {
            t = newTarget(prop, layer);
            t.kind = "scale";
            t.dims = dims;
            t.percent = true;
            t.value = fitArray(valueNow(prop, comp), dims, 100);
            return [t];
        }

        // Position
        if (!isSeparated(prop)) {
            t = newTarget(prop, layer);
            t.kind = "vector";
            t.dims = dims;
            t.value = fitArray(valueNow(prop, comp), dims, 0);
            return [t];
        }

        // Separate Dimensions is on: link X / Y (/ Z) Position to the
        // matching part of one point control.
        var parts = [];
        var whole = [];
        var i;
        for (i = 0; i < dims; i++) {
            var dimProp = xf.property("ADBE Position_" + i);
            if (!dimProp) {
                warnings.push(quoted(layer.name) + ": couldn't read its separated Position - skipped.");
                return [];
            }
            parts.push(dimProp);
            whole.push(valueNow(dimProp, comp));
        }
        var out = [];
        for (i = 0; i < parts.length; i++) {
            t = newTarget(parts[i], layer);
            t.component = i;
            t.value = whole[i];
            t.vectorValue = whole;
            t.vectorDims = dims;
            out.push(t);
        }
        return out;
    }

    function unitsOf(prop) {
        if (PERCENT_MATCHNAMES[prop.matchName]) return "percent";
        if (DEGREE_MATCHNAMES[prop.matchName]) return "degrees";
        var units = "";
        try {
            units = String(prop.unitsText).toLowerCase();
        } catch (e) {}
        if (units.indexOf("percent") >= 0 || units === "%") return "percent";
        if (units.indexOf("degree") >= 0) return "degrees";
        return "";
    }

    function labelForProperty(prop, parent, inTransform) {
        if (inTransform || !parent) return prop.name;
        var owner = parent;
        // Text animator properties live in a hidden "Properties" group.
        if (owner.matchName === "ADBE Text Animator Properties" && owner.parentProperty) {
            owner = owner.parentProperty;
        }
        return owner.name + " " + prop.name;
    }

    // Target for a property the user selected in the timeline.
    function classifyProperty(prop, layer, comp, warnings) {
        var VT = PropertyValueType;
        var vt = prop.propertyValueType;
        var parent = prop.parentProperty;
        var inTransform = !!parent && parent.matchName === "ADBE Transform Group";
        var units = unitsOf(prop);

        var t = newTarget(prop, layer);
        t.label = labelForProperty(prop, parent, inTransform);
        t.percent = units === "percent";
        t.degrees = units === "degrees";

        if (vt === VT.OneD) {
            t.value = valueNow(prop, comp);
        } else if (vt === VT.TwoD || vt === VT.TwoD_SPATIAL || vt === VT.ThreeD || vt === VT.ThreeD_SPATIAL) {
            if (inTransform) {
                // Layer transforms report 3 values even on 2D layers.
                t.dims = (prop.matchName === "ADBE Orientation" || is3D(layer)) ? 3 : 2;
            } else {
                t.dims = (vt === VT.ThreeD || vt === VT.ThreeD_SPATIAL) ? 3 : 2;
            }
            // Percent vectors (Scale) get one uniform slider; others a point.
            t.kind = t.percent ? "scale" : "vector";
            t.value = fitArray(valueNow(prop, comp), t.dims, t.percent ? 100 : 0);
        } else if (vt === VT.COLOR) {
            t.kind = "color";
            t.dims = 4;
            t.value = valueNow(prop, comp);
        } else {
            warnings.push(describeTarget(t) + " can't be driven by a control - skipped.");
            return null;
        }
        return t;
    }

    function collectFromLayers(comp, selected, controller, choice, warnings) {
        var layers = [];
        var i;
        for (i = 0; i < selected.length; i++) {
            if (controller && selected[i].index === controller.index) continue;
            layers.push(selected[i]);
        }
        if (layers.length === 0) {
            throw userError(controller
                ? "Select the layers to link as well as the control null."
                : "Select the layers you want to link, then click Link.");
        }
        var targets = [];
        for (i = 0; i < layers.length; i++) {
            targets = targets.concat(targetsForChoice(layers[i], choice, comp, warnings));
        }
        return targets;
    }

    function collectSelectedProperties(comp, controller, warnings) {
        var props = comp.selectedProperties;
        var targets = [];
        var found = 0;
        for (var i = 0; i < props.length; i++) {
            var prop = props[i];
            if (prop.propertyType !== PropertyType.PROPERTY) continue;
            var layer = prop.propertyGroup(prop.propertyDepth);
            if (controller && layer.index === controller.index) continue;
            found++;
            var t = classifyProperty(prop, layer, comp, warnings);
            if (t) targets.push(t);
        }
        if (found === 0) {
            throw userError("No properties are selected.\n\n" +
                "Twirl open your layers and select the properties to link " +
                "(Ctrl/Cmd-click to pick several), or choose a property from the list.");
        }
        return targets;
    }

    // Drop targets we can't or shouldn't write to.
    function filterWritable(targets, overwrite, warnings) {
        var out = [];
        var lockedSeen = {};
        var hadExpression = 0;
        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            if (t.layer.locked) {
                if (!lockedSeen["k" + t.layer.index]) {
                    warnings.push(quoted(t.layer.name) + " is locked - skipped.");
                    lockedSeen["k" + t.layer.index] = true;
                }
                continue;
            }
            if (!t.prop.canSetExpression) {
                warnings.push(describeTarget(t) + " can't take an expression - skipped.");
                continue;
            }
            if (!overwrite && t.prop.expression !== "") {
                hadExpression++;
                continue;
            }
            out.push(t);
        }
        if (hadExpression > 0) {
            warnings.push(plural(hadExpression, "property", "properties") +
                " already had an expression and " + (hadExpression === 1 ? "was" : "were") +
                " left alone. Turn on \"Overwrite existing expressions\" to replace them.");
        }
        return out;
    }

    // Top-most layer first (so Absolute controls start from the top layer's
    // value), keeping the original order within a layer. ES3 sort isn't
    // guaranteed stable, hence the explicit tie-break.
    function sortByLayer(targets) {
        for (var i = 0; i < targets.length; i++) targets[i].order = i;
        targets.sort(function (a, b) {
            return (a.layer.index - b.layer.index) || (a.order - b.order);
        });
        return targets;
    }

    // One control per group. Menu choices make a single group; "Selected
    // Properties" makes one group per kind of property (by matchName).
    function groupTargets(targets, choice) {
        var groups = [];
        var byKey = {};
        for (var i = 0; i < targets.length; i++) {
            var t = targets[i];
            var key = "k:" + (choice.id === "selected" ? t.prop.matchName : choice.id);
            var g = byKey[key];
            if (!g) {
                g = {
                    label: choice.id === "selected" ? t.label : choice.label,
                    kind: choice.id === "position" ? "vector" : t.kind,
                    percent: t.percent,
                    degrees: t.degrees,
                    targets: [],
                    maxDims: 0
                };
                byKey[key] = g;
                groups.push(g);
            }
            g.targets.push(t);
            var d = t.component >= 0 ? t.vectorDims : t.dims;
            if (d > g.maxDims) g.maxDims = d;
        }
        return groups;
    }


    // =====================================================================
    // The control null and its controls
    // =====================================================================

    function findSelectedNull(selected) {
        var nulls = [];
        for (var i = 0; i < selected.length; i++) {
            if (selected[i].nullLayer) nulls.push(selected[i]);
        }
        if (nulls.length === 0) {
            throw userError("\"Add to the selected control null\" is on, but no null layer is selected.\n\n" +
                "Select the control null along with the layers, or turn the option off to make a new one.");
        }
        if (nulls.length > 1) {
            throw userError("More than one null layer is selected. Select just one control null.");
        }
        return nulls[0];
    }

    function uniqueLayerName(comp, base, skipIndex) {
        var taken = {};
        for (var i = 1; i <= comp.numLayers; i++) {
            if (i !== skipIndex) taken["k:" + comp.layer(i).name] = true;
        }
        if (!taken["k:" + base]) return base;
        var n = 2;
        while (taken["k:" + base + " " + n]) n++;
        return base + " " + n;
    }

    // Expressions find the null by name, so warn if a layer above it shares it.
    function checkControllerName(comp, controller, warnings) {
        for (var i = 1; i <= comp.numLayers; i++) {
            if (comp.layer(i).name === controller.name) {
                if (i !== controller.index) {
                    warnings.push("Another layer above the control null is also named " + quoted(controller.name) +
                        ". Expressions find layers by name, so rename one of them.");
                }
                return;
            }
        }
    }

    function createController(comp, groups, targets) {
        var top = targets[0].layer;
        for (var i = 1; i < targets.length; i++) {
            if (targets[i].layer.index < top.index) top = targets[i].layer;
        }
        var base = groups.length === 1 ? groups[0].label + NULL_SUFFIX : "Property Controls";
        var nullLayer = comp.layers.addNull();
        nullLayer.name = uniqueLayerName(comp, base, nullLayer.index);
        nullLayer.moveBefore(top);
        return nullLayer;
    }

    function controlTypeFor(g) {
        if (g.kind === "color") return "color";
        if (g.kind === "vector") return g.maxDims >= 3 ? "point3d" : "point";
        if (g.kind === "scalar" && g.degrees) return "angle";
        return "slider"; // scalars, and Scale (one uniform slider)
    }

    // Control value that leaves every layer unchanged in Relative mode.
    function neutralValue(g, spec) {
        if (g.kind === "color") return [1, 1, 1, 1];
        if (g.kind === "vector") return filled(spec.dims, 0);
        if (g.kind === "scale" || g.percent) return 100;
        return 0;
    }

    // Absolute mode starts the control at the top layer's current value.
    function startingValue(g, spec) {
        var t = g.targets[0];
        if (g.kind === "vector") return fitArray(t.vectorValue || t.value, spec.dims, 0);
        if (g.kind === "scale") return t.value[0];
        return t.value;
    }

    // Reuse an effect with this name and type, or add a new one.
    function ensureEffect(layer, label, spec, initValue) {
        var parade = layer.property("ADBE Effect Parade");
        if (!parade) throw userError(quoted(layer.name) + " can't hold effects.");
        var taken = {};
        for (var i = 1; i <= parade.numProperties; i++) {
            var existing = parade.property(i);
            if (existing.name === label && existing.matchName === spec.matchName) return existing.name;
            taken["k:" + existing.name] = true;
        }
        if (!parade.canAddProperty(spec.matchName)) {
            throw userError("Couldn't add a " + spec.label + " to " + quoted(layer.name) + ".");
        }
        var name = label;
        var n = 2;
        while (taken["k:" + name]) {
            name = label + " " + n;
            n++;
        }
        var effect = parade.addProperty(spec.matchName);
        effect.name = name;
        try {
            effect.property(1).setValue(initValue);
        } catch (e) {}
        return name;
    }

    // ref: expression that evaluates to the control's value; dims: its size.
    function prepareControl(controller, nullRef, g, relative) {
        var spec = CONTROLS[controlTypeFor(g)];
        var init = relative ? neutralValue(g, spec) : startingValue(g, spec);
        var effectName = ensureEffect(controller, g.label, spec, init);
        return {
            ref: nullRef + ".effect(" + exprString(effectName) + ")(1).value",
            dims: spec.dims
        };
    }


    // =====================================================================
    // Expressions
    //
    // Controls are read with .value and vectors use add/mul, so these work
    // in both the JavaScript and Legacy ExtendScript expression engines.
    // =====================================================================

    // Return the control as-is, or reshape it when sizes differ
    // (a 3D point driving a 2D layer drops Z; a missing Z keeps the layer's).
    function fitExpression(ref, from, to) {
        if (from === to) return ref + ";";
        var parts = [];
        for (var k = 0; k < to; k++) parts.push(k < from ? "c[" + k + "]" : "value[" + k + "]");
        return "var c = " + ref + ";\n[" + parts.join(", ") + "];";
    }

    function scalarExpression(ref, relative, percent) {
        if (!relative) return ref + ";";
        if (percent) return "value * " + ref + " / 100;";
        return "value + " + ref + ";";
    }

    function scaleExpression(ref, dims, relative) {
        if (relative) return "mul(value, " + ref + " / 100);";
        return "var s = " + ref + ";\n[" + filled(dims, "s").join(", ") + "];";
    }

    function vectorExpression(ref, from, to, relative) {
        if (!relative) return fitExpression(ref, from, to);
        if (from === to) return "add(value, " + ref + ");";
        var parts = [];
        for (var k = 0; k < to; k++) {
            parts.push(k < from ? "value[" + k + "] + c[" + k + "]" : "value[" + k + "]");
        }
        return "var c = " + ref + ";\n[" + parts.join(", ") + "];";
    }

    function colorExpression(ref, relative) {
        if (!relative) return ref + ";";
        // Relative colour = tint: white leaves the layer's colour unchanged.
        return "var c = " + ref + ";\n[value[0] * c[0], value[1] * c[1], value[2] * c[2], value[3]];";
    }

    function buildExpression(t, ctl, relative) {
        if (t.component >= 0) return scalarExpression(ctl.ref + "[" + t.component + "]", relative, false);
        if (t.kind === "scale") return scaleExpression(ctl.ref, t.dims, relative);
        if (t.kind === "vector") return vectorExpression(ctl.ref, ctl.dims, t.dims, relative);
        if (t.kind === "color") return colorExpression(ctl.ref, relative);
        return scalarExpression(ctl.ref, relative, t.percent);
    }

    function applyExpression(t, expr, warnings) {
        try {
            t.prop.expression = expr;
        } catch (e) {
            warnings.push(describeTarget(t) + ": couldn't add the expression (" + e.message + ").");
            return false;
        }
        var err = "";
        try {
            err = t.prop.expressionError;
        } catch (e2) {}
        if (err) {
            warnings.push(describeTarget(t) + ": expression error - " + err);
            return false;
        }
        return true;
    }


    // =====================================================================
    // Main action
    // =====================================================================

    // opts: { choice, relative, useExisting, overwrite }
    function linkSelection(opts) {
        var comp = app.project ? app.project.activeItem : null;
        if (!(comp instanceof CompItem)) {
            throw userError("Open a composition and select the layers you want to link.");
        }
        var choice = CHOICES[opts.choice] || CHOICES.opacity;
        var warnings = [];
        var selected = comp.selectedLayers;
        var i, j;

        var controller = null;
        if (opts.useExisting) {
            controller = findSelectedNull(selected);
            if (controller.locked) throw userError("The control null " + quoted(controller.name) + " is locked.");
        }

        var targets = choice.id === "selected"
            ? collectSelectedProperties(comp, controller, warnings)
            : collectFromLayers(comp, selected, controller, choice, warnings);
        targets = sortByLayer(filterWritable(targets, opts.overwrite, warnings));
        if (targets.length === 0) {
            throw userError("Nothing was linked.\n\n" + warnings.join("\n"));
        }
        var groups = groupTargets(targets, choice);

        var isNew = !controller;
        var linked = 0;
        var layerCount = 0;
        var layersSeen = {};

        app.beginUndoGroup(UNDO_NAME);
        try {
            if (isNew) {
                controller = createController(comp, groups, targets);
            } else {
                checkControllerName(comp, controller, warnings);
            }
            var nullRef = "thisComp.layer(" + exprString(controller.name) + ")";

            for (i = 0; i < groups.length; i++) {
                var g = groups[i];
                var ctl = prepareControl(controller, nullRef, g, opts.relative);
                for (j = 0; j < g.targets.length; j++) {
                    var t = g.targets[j];
                    if (applyExpression(t, buildExpression(t, ctl, opts.relative), warnings)) {
                        linked++;
                        if (!layersSeen["k" + t.layer.index]) {
                            layersSeen["k" + t.layer.index] = true;
                            layerCount++;
                        }
                    }
                }
            }

            // Select the null so its controls show in Effect Controls.
            for (i = 0; i < selected.length; i++) {
                try {
                    selected[i].selected = false;
                } catch (e) {}
            }
            try {
                controller.selected = true;
            } catch (e2) {}
        } finally {
            app.endUndoGroup();
        }

        return {
            linked: linked,
            layerCount: layerCount,
            propertyLabel: choice.id === "selected" ? null : choice.label,
            controllerName: controller.name,
            created: isNew,
            warnings: warnings
        };
    }

    function summarize(result) {
        if (result.linked === 0) return "Nothing was linked.";
        var layers = plural(result.layerCount, "layer", "layers");
        var what = result.propertyLabel
            ? result.propertyLabel + " on " + layers
            : plural(result.linked, "property", "properties") + " on " + layers;
        return "Linked " + what + " to " + (result.created ? "new null " : "") + quoted(result.controllerName) + ".";
    }


    // =====================================================================
    // API for the panel
    // =====================================================================

    root.PropertyLinker = {
        version: VERSION,

        // Returns a JSON string:
        //   { ok: true, message, warnings[], linked, layerCount, controllerName, created }
        //   { ok: false, userError, message }
        link: function (choice, relative, useExisting, overwrite) {
            try {
                var r = linkSelection({
                    choice: String(choice),
                    relative: relative === true,
                    useExisting: useExisting === true,
                    overwrite: overwrite === true
                });
                return toJSON({
                    ok: true,
                    message: summarize(r),
                    warnings: r.warnings,
                    linked: r.linked,
                    layerCount: r.layerCount,
                    controllerName: r.controllerName,
                    created: r.created
                });
            } catch (e) {
                return toJSON({
                    ok: false,
                    userError: e.isUserError === true,
                    message: e.isUserError
                        ? e.message
                        : "Something went wrong: " + e.toString() + (e.line ? " (line " + e.line + ")" : "") +
                          "\nUse Edit > Undo to revert any partial changes."
                });
            }
        }
    };

})((typeof $ !== "undefined" && $.global) ? $.global : this);
