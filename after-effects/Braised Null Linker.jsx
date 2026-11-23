/*
 * Braised Null Linker  v1.0
 * Braised Animation - After Effects tool
 *
 * Wire the same property on many layers to one control null in one click.
 *
 *   1. Select the layers you want to control.
 *   2. Pick a property (Opacity, Rotation, Scale, Position), or pick
 *      "Selected Properties" and select the exact properties in the timeline.
 *   3. Choose what drives them:
 *        - an expression control on the null (Slider, Angle, Point or Color)
 *        - the null's own matching transform property
 *   4. Choose Absolute (every layer matches the control) or Relative (each
 *      layer keeps its own value and keyframes; the control multiplies
 *      percentages and offsets everything else).
 *   5. Click Link.
 *
 * Install: copy this file into After Effects' "Scripts/ScriptUI Panels"
 * folder, restart After Effects, and open it from the Window menu (it docks
 * like any panel). It also runs as a floating window from
 * File > Scripts > Run Script File...
 *
 * Note: ExtendScript is ES3 - no Array.indexOf/map/forEach, JSON or trim.
 */

(function braisedNullLinker(thisObj) {

    var SCRIPT_NAME = "Braised Null Linker";
    var SCRIPT_VERSION = "1.0";
    var SETTINGS_SECTION = "BraisedNullLinker";
    var NULL_PREFIX = "CTRL - ";

    // Property menu. A null entry is a separator line.
    var CHOICES = [
        { id: "opacity",  label: "Opacity",  control: "Slider Control", matchName: "ADBE Opacity" },
        { id: "rotation", label: "Rotation", control: "Angle Control",  matchName: "ADBE Rotate Z" },
        { id: "scale",    label: "Scale",    control: "Slider Control", matchName: "ADBE Scale" },
        { id: "position", label: "Position", control: "Point Control",  matchName: "ADBE Position" },
        null,
        { id: "selected", label: "Selected Properties", control: "Expression Controls", matchName: null }
    ];

    var HINTS = {
        absolute: {
            opacity:  "Every layer's Opacity is set to the control's value.",
            rotation: "Every layer's Rotation is set to the control's value.",
            scale:    "Every layer's Scale is set to the control's value.",
            position: "Every layer's Position is set to the control's value.",
            selected: "Every property is set to its control's value."
        },
        relative: {
            opacity:  "Multiplies each layer's own Opacity. 100% = unchanged.",
            rotation: "Adds to each layer's own Rotation. 0 = unchanged.",
            scale:    "Multiplies each layer's own Scale. 100% = unchanged.",
            position: "Offsets each layer's own Position.",
            selected: "Multiplies % values (100 = unchanged) and offsets the rest."
        }
    };

    // Expression control effects. dims = size of the control's value.
    var CONTROLS = {
        slider:  { matchName: "ADBE Slider Control",  label: "Slider Control",   dims: 1 },
        angle:   { matchName: "ADBE Angle Control",   label: "Angle Control",    dims: 1 },
        point:   { matchName: "ADBE Point Control",   label: "Point Control",    dims: 2 },
        point3d: { matchName: "ADBE Point3D Control", label: "3D Point Control", dims: 3 },
        color:   { matchName: "ADBE Color Control",   label: "Color Control",    dims: 4 }
    };

    // Layer transform properties a null can drive with its own transform.
    //   expr      - name in the expression language (thisLayer.transform.<expr>)
    //   source    - matchName of the null's property that holds the value
    //   dims      - size of the null's value; "layer" = 2 or 3 depending on 3D
    //   component - the property is one dimension of a vector (separated Position)
    //   needs3D   - only exists on 3D layers
    var TRANSFORM_MAP = {
        "ADBE Anchor Point": { expr: "anchorPoint", source: "ADBE Anchor Point", dims: "layer" },
        "ADBE Position":     { expr: "position",    source: "ADBE Position",     dims: "layer" },
        "ADBE Position_0":   { expr: "position",    source: "ADBE Position",     dims: "layer", component: 0 },
        "ADBE Position_1":   { expr: "position",    source: "ADBE Position",     dims: "layer", component: 1 },
        "ADBE Position_2":   { expr: "position",    source: "ADBE Position",     dims: "layer", component: 2, needs3D: true },
        "ADBE Scale":        { expr: "scale",       source: "ADBE Scale",        dims: "layer" },
        "ADBE Orientation":  { expr: "orientation", source: "ADBE Orientation",  dims: 3, needs3D: true },
        "ADBE Rotate X":     { expr: "xRotation",   source: "ADBE Rotate X",     dims: 1, needs3D: true },
        "ADBE Rotate Y":     { expr: "yRotation",   source: "ADBE Rotate Y",     dims: 1, needs3D: true },
        "ADBE Rotate Z":     { expr: "rotation",    source: "ADBE Rotate Z",     dims: 1 },
        "ADBE Opacity":      { expr: "opacity",     source: "ADBE Opacity",      dims: 1 }
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

    function getChoice(id) {
        for (var i = 0; i < CHOICES.length; i++) {
            if (CHOICES[i] && CHOICES[i].id === id) return CHOICES[i];
        }
        return CHOICES[0];
    }

    function choiceIndex(id) {
        for (var i = 0; i < CHOICES.length; i++) {
            if (CHOICES[i] && CHOICES[i].id === id) return i;
        }
        return 0;
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

    function formatNumber(n) {
        return String(Math.round(n * 1000) / 1000);
    }

    function formatVector(v) {
        var parts = [];
        for (var i = 0; i < v.length; i++) parts.push(formatNumber(v[i]));
        return "[" + parts.join(", ") + "]";
    }

    function isZero(v) {
        if (typeof v === "number") return Math.round(v * 1000) === 0;
        for (var i = 0; i < v.length; i++) {
            if (Math.round(v[i] * 1000) !== 0) return false;
        }
        return true;
    }

    // " - 12" or " + 12" (so a negative start doesn't print as "- -12").
    function minus(n) {
        return n < 0 ? " + " + formatNumber(-n) : " - " + formatNumber(n);
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


    // =====================================================================
    // Finding what to link
    //
    // A "target" is one property that will get an expression:
    //   kind        scalar | scale | vector | color
    //   dims        how many values the property's expression returns
    //   component   >= 0 when the target is one dimension of a vector control
    //               (Position with Separate Dimensions turned on)
    //   transform   TRANSFORM_MAP entry when a null's transform can drive it
    //   value       current value (initialises Absolute controls)
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
            transform: null,
            value: null,
            vectorValue: null,
            vectorDims: 0
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
            t.transform = TRANSFORM_MAP[choice.matchName];
            t.value = valueNow(prop, comp);
            return [t];
        }

        if (choice.id === "scale") {
            t = newTarget(prop, layer);
            t.kind = "scale";
            t.dims = dims;
            t.percent = true;
            t.transform = TRANSFORM_MAP[choice.matchName];
            t.value = fitArray(valueNow(prop, comp), dims, 100);
            return [t];
        }

        // Position
        if (!isSeparated(prop)) {
            t = newTarget(prop, layer);
            t.kind = "vector";
            t.dims = dims;
            t.transform = TRANSFORM_MAP[choice.matchName];
            t.value = fitArray(valueNow(prop, comp), dims, 0);
            return [t];
        }

        // Separate Dimensions is on: link X / Y (/ Z) Position to the
        // matching component of one point control.
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
            t.transform = TRANSFORM_MAP[choice.matchName];
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
        t.transform = inTransform ? (TRANSFORM_MAP[prop.matchName] || null) : null;
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
                ? "Select the layers to link as well as the controller null."
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
                    transform: choice.id === "selected" ? t.transform : TRANSFORM_MAP[choice.matchName],
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
    // The controller null and its controls
    // =====================================================================

    function findSelectedNull(selected) {
        var nulls = [];
        for (var i = 0; i < selected.length; i++) {
            if (selected[i].nullLayer) nulls.push(selected[i]);
        }
        if (nulls.length === 0) {
            throw userError("\"Use a selected null as the controller\" is on, but no null layer is selected.\n\n" +
                "Select your controller null along with the layers, or turn the option off to make a new null.");
        }
        if (nulls.length > 1) {
            throw userError("More than one null layer is selected. Select just one null to act as the controller.");
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
                    warnings.push("Another layer above the controller is also named " + quoted(controller.name) +
                        ". Expressions find layers by name, so rename one of them.");
                }
                return;
            }
        }
    }

    // Which groups will use the null's own transform property.
    function usesTransform(g, opts, controller) {
        if (opts.link !== "transform" || !g.transform) return false;
        if (g.transform.needs3D && controller && !is3D(controller)) return false;
        return true;
    }

    function needs3DNull(groups, opts) {
        for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            if (!usesTransform(g, opts, null)) continue;
            if (g.transform.needs3D) return true;
            if (g.transform.dims === "layer" && g.maxDims >= 3) return true;
        }
        return false;
    }

    function createController(comp, groups, targets, opts) {
        var top = targets[0].layer;
        for (var i = 1; i < targets.length; i++) {
            if (targets[i].layer.index < top.index) top = targets[i].layer;
        }
        var labels = [];
        for (i = 0; i < groups.length; i++) labels.push(groups[i].label);
        var base = NULL_PREFIX + (labels.length <= 2 ? labels.join(" + ") : "Controls");

        var nullLayer = comp.layers.addNull();
        nullLayer.name = uniqueLayerName(comp, base, nullLayer.index);
        if (needs3DNull(groups, opts)) nullLayer.threeDLayer = true;
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

    // Absolute mode starts the control at the first layer's current value.
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
        if (initValue !== null && initValue !== undefined) {
            try {
                effect.property(1).setValue(initValue);
            } catch (e) {}
        }
        return name;
    }

    // Write v into prop (or just one component of it), keeping the rest.
    function setValueInto(prop, v, component) {
        var current = prop.value;
        if (typeof current === "number") {
            prop.setValue(typeof v === "number" ? v : v[0]);
            return;
        }
        var next = current.slice(0);
        if (component >= 0) {
            next[component] = typeof v === "number" ? v : v[component];
        } else {
            for (var k = 0; k < next.length && k < v.length; k++) next[k] = v[k];
        }
        prop.setValue(next);
    }

    function readTransformValue(xf, source, comp) {
        var prop = xf.property(source);
        if (source === "ADBE Position" && isSeparated(prop)) {
            var v = [];
            for (var i = 0; i < 3; i++) {
                var dimProp = xf.property("ADBE Position_" + i);
                v.push(dimProp ? valueNow(dimProp, comp) : 0);
            }
            return v;
        }
        return valueNow(prop, comp);
    }

    // Average of the targets' values (one sample per layer).
    function centroid(g) {
        var sum = null;
        var count = 0;
        var seen = {};
        for (var i = 0; i < g.targets.length; i++) {
            var t = g.targets[i];
            if (seen["k" + t.layer.index]) continue;
            seen["k" + t.layer.index] = true;
            var v = t.vectorValue || t.value;
            if (typeof v === "number") v = [v];
            if (!sum) sum = filled(3, 0);
            for (var k = 0; k < v.length && k < 3; k++) sum[k] += v[k];
            count++;
        }
        for (var j = 0; j < 3; j++) sum[j] /= count;
        return sum;
    }

    // Describes the control a group's expressions read from:
    //   ref    expression that evaluates to the control's value
    //   dims   size of that value
    //   start  Relative + null transform: the null's value right now, so
    //          linking doesn't make anything jump
    function prepareControl(comp, controller, isNew, nullRef, g, opts, warnings) {
        var entry = usesTransform(g, opts, controller) ? g.transform : null;
        var spec;

        if (!entry) {
            spec = CONTROLS[controlTypeFor(g)];
            if (opts.link === "transform") {
                warnings.push("Note: " + g.label + (g.transform
                    ? " needs a 3D null, so it uses a " + spec.label + " instead."
                    : " isn't a transform property, so it uses a " + spec.label + " on the null instead."));
            }
            var init = opts.relative ? neutralValue(g, spec) : startingValue(g, spec);
            var effectName = ensureEffect(controller, g.label, spec, init);
            return {
                ref: nullRef + ".effect(" + exprString(effectName) + ")(1).value",
                dims: spec.dims,
                start: null,
                isTransform: false,
                component: -1
            };
        }

        var xf = controller.property("ADBE Transform Group");
        var nullProp = xf.property(entry.source);
        var nullDims = entry.dims === "layer" ? (is3D(controller) ? 3 : 2) : entry.dims;
        var component = typeof entry.component === "number" ? entry.component : -1;
        var multiplies = g.percent || g.kind === "scale";

        // Only a null we just made gets moved/changed; an existing one is
        // left exactly as the user set it up.
        if (isNew) {
            var first = g.targets[0];
            if (!opts.relative) {
                setValueInto(nullProp, component >= 0 ? first.value : (first.vectorValue || first.value), component);
            } else if (!multiplies && entry.source === "ADBE Position") {
                setValueInto(nullProp, centroid(g), component);
            }
        }

        var start = null;
        if (opts.relative && !multiplies) {
            start = readTransformValue(xf, entry.source, comp);
            if (typeof start !== "number") start = fitArray(start, nullDims, 0);
        }
        return {
            ref: nullRef + ".transform." + entry.expr + ".value",
            dims: nullDims,
            start: start,
            isTransform: true,
            component: component
        };
    }


    // =====================================================================
    // Expressions
    //
    // All controls are read with .value and vectors use add/sub/mul, so the
    // expressions work in both the JavaScript and Legacy ExtendScript engines.
    // =====================================================================

    // Return the control as-is, or reshape it when the sizes differ
    // (2D control -> 3D layer keeps the layer's own Z; 3D -> 2D drops Z).
    function fitExpression(ref, from, to) {
        if (from === to) return ref + ";";
        var parts = [];
        for (var k = 0; k < to; k++) parts.push(k < from ? "c[" + k + "]" : "value[" + k + "]");
        return "var c = " + ref + ";\n[" + parts.join(", ") + "];";
    }

    function scalarExpression(ref, relative, percent, start) {
        if (!relative) return ref + ";";
        if (percent) return "value * " + ref + " / 100;";
        if (typeof start === "number" && !isZero(start)) return "value + (" + ref + minus(start) + ");";
        return "value + " + ref + ";";
    }

    function scaleFromSlider(ref, dims, relative) {
        if (relative) return "mul(value, " + ref + " / 100);";
        return "var s = " + ref + ";\n[" + filled(dims, "s").join(", ") + "];";
    }

    function scaleFromVector(ref, from, to, relative) {
        if (!relative) return fitExpression(ref, from, to);
        var parts = [];
        for (var k = 0; k < to; k++) {
            parts.push(k < from ? "value[" + k + "] * c[" + k + "] / 100" : "value[" + k + "]");
        }
        return "var c = " + ref + ";\n[" + parts.join(", ") + "];";
    }

    function vectorExpression(ref, from, to, relative, start) {
        if (!relative) return fitExpression(ref, from, to);
        var offset = start !== null && typeof start !== "number" && !isZero(start);
        if (from === to) {
            return offset
                ? "add(value, sub(" + ref + ", " + formatVector(start) + "));"
                : "add(value, " + ref + ");";
        }
        var parts = [];
        for (var k = 0; k < to; k++) {
            if (k >= from) parts.push("value[" + k + "]");
            else parts.push("value[" + k + "] + " + (offset ? "(c[" + k + "]" + minus(start[k]) + ")" : "c[" + k + "]"));
        }
        return "var c = " + ref + ";\n[" + parts.join(", ") + "];";
    }

    function colorExpression(ref, relative) {
        if (!relative) return ref + ";";
        // Relative colour = tint: white leaves the layer's colour unchanged.
        return "var c = " + ref + ";\n[value[0] * c[0], value[1] * c[1], value[2] * c[2], value[3]];";
    }

    function buildExpression(t, ctl, relative) {
        var index = t.component >= 0 ? t.component : ctl.component;
        if (index >= 0) {
            // One dimension of a vector control (separated Position, or
            // X/Y Position driven by the null's Position).
            var start = ctl.start;
            if (start !== null && typeof start !== "number") start = start[index];
            return scalarExpression(ctl.ref + "[" + index + "]", relative, false, start);
        }
        if (t.kind === "scale") {
            return ctl.isTransform
                ? scaleFromVector(ctl.ref, ctl.dims, t.dims, relative)
                : scaleFromSlider(ctl.ref, t.dims, relative);
        }
        if (t.kind === "vector") return vectorExpression(ctl.ref, ctl.dims, t.dims, relative, ctl.start);
        if (t.kind === "color") return colorExpression(ctl.ref, relative);
        return scalarExpression(ctl.ref, relative, t.percent, ctl.start);
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

    // opts: { choice, link: "effect"|"transform", relative, useExisting, overwrite }
    function linkSelection(opts) {
        var comp = app.project ? app.project.activeItem : null;
        if (!(comp instanceof CompItem)) {
            throw userError("Open a composition and select the layers you want to link.");
        }
        var choice = getChoice(opts.choice);
        var warnings = [];
        var selected = comp.selectedLayers;
        var i, j;

        var controller = null;
        if (opts.useExisting) {
            controller = findSelectedNull(selected);
            if (controller.locked) throw userError("The controller null " + quoted(controller.name) + " is locked.");
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

        app.beginUndoGroup(SCRIPT_NAME);
        try {
            if (isNew) {
                controller = createController(comp, groups, targets, opts);
            } else {
                checkControllerName(comp, controller, warnings);
            }
            var nullRef = "thisComp.layer(" + exprString(controller.name) + ")";

            for (i = 0; i < groups.length; i++) {
                var g = groups[i];
                var ctl = prepareControl(comp, controller, isNew, nullRef, g, opts, warnings);
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
    // Settings
    // =====================================================================

    function loadSetting(key, fallback) {
        try {
            if (app.settings.haveSetting(SETTINGS_SECTION, key)) {
                return app.settings.getSetting(SETTINGS_SECTION, key);
            }
        } catch (e) {}
        return fallback;
    }

    function saveSetting(key, value) {
        try {
            app.settings.saveSetting(SETTINGS_SECTION, key, String(value));
        } catch (e) {}
    }


    // =====================================================================
    // UI
    // =====================================================================

    var HELP_TEXT =
        SCRIPT_NAME + " v" + SCRIPT_VERSION + "\n\n" +
        "1. Select the layers you want to control.\n" +
        "2. Pick a property. For anything else (effect values, shape fills, text animators...) " +
        "choose \"Selected Properties\" and select those properties in the timeline.\n" +
        "3. Click Link. A null named \"CTRL - ...\" is added above the layers and each layer gets an expression.\n\n" +
        "LINK TO\n" +
        "Control on the null: adds a Slider (Opacity, Scale), Angle (Rotation), Point (Position) " +
        "or Color Control to the null.\n" +
        "The null's own property: the layers follow the null's Opacity / Rotation / Scale / Position.\n\n" +
        "MODE\n" +
        "Absolute: every layer takes the control's value (keyframes on the layers are overridden).\n" +
        "Relative: each layer keeps its own value and keyframes. The control multiplies % values " +
        "(Opacity, Scale: 100 = unchanged) and offsets everything else (0 = unchanged).\n\n" +
        "MORE\n" +
        "Use a selected null: select an existing null along with new layers to hook them up to it. " +
        "A control with the same name is reused.\n" +
        "Renaming the null or its effects later is safe - After Effects updates the expressions.\n" +
        "Each Link is a single undo step.";

    function buildUI(host) {
        var win = (host instanceof Panel)
            ? host
            : new Window("palette", SCRIPT_NAME, undefined, { resizeable: true });
        if (!win) return;

        win.orientation = "column";
        win.alignChildren = ["fill", "top"];
        win.spacing = 8;
        win.margins = 12;

        // Property
        var propRow = win.add("group");
        propRow.orientation = "row";
        propRow.alignChildren = ["left", "center"];
        propRow.add("statictext", undefined, "Property:");
        var names = [];
        for (var i = 0; i < CHOICES.length; i++) names.push(CHOICES[i] ? CHOICES[i].label : "-");
        var propList = propRow.add("dropdownlist", undefined, names);
        propList.alignment = ["fill", "center"];
        propList.helpTip = "Which property to link on the selected layers.";

        // Link to
        var linkPanel = win.add("panel", undefined, "Link to");
        linkPanel.orientation = "column";
        linkPanel.alignChildren = ["fill", "top"];
        linkPanel.margins = [10, 15, 10, 10];
        linkPanel.spacing = 4;
        var linkEffect = linkPanel.add("radiobutton", undefined, "Slider Control on the null");
        linkEffect.helpTip = "Add an expression control effect to the null and drive the layers with it.";
        var linkTransform = linkPanel.add("radiobutton", undefined, "The null's own Opacity");
        linkTransform.helpTip = "Drive the layers with the null's matching transform property.";

        // Mode
        var modePanel = win.add("panel", undefined, "Mode");
        modePanel.orientation = "column";
        modePanel.alignChildren = ["fill", "top"];
        modePanel.margins = [10, 15, 10, 10];
        modePanel.spacing = 4;
        var modeRow = modePanel.add("group");
        modeRow.orientation = "row";
        modeRow.alignChildren = ["left", "center"];
        var modeAbs = modeRow.add("radiobutton", undefined, "Absolute");
        modeAbs.helpTip = "Every layer takes the control's value.";
        var modeRel = modeRow.add("radiobutton", undefined, "Relative");
        modeRel.helpTip = "Each layer keeps its own value and keyframes; the control scales or offsets it.";
        var hint = modePanel.add("statictext", undefined, "", { multiline: true });
        hint.alignment = ["fill", "top"];
        hint.preferredSize.height = 30;

        // Options
        var optGroup = win.add("group");
        optGroup.orientation = "column";
        optGroup.alignChildren = ["left", "top"];
        optGroup.spacing = 4;
        var useNull = optGroup.add("checkbox", undefined, "Use a selected null as the controller");
        useNull.helpTip = "Hook the layers up to a null that's part of your selection instead of making a new one.";
        var overwrite = optGroup.add("checkbox", undefined, "Overwrite existing expressions");
        overwrite.helpTip = "Off: properties that already have an expression are left alone.";

        // Buttons
        var buttonRow = win.add("group");
        buttonRow.orientation = "row";
        buttonRow.alignChildren = ["fill", "center"];
        var linkButton = buttonRow.add("button", undefined, "Link");
        linkButton.alignment = ["fill", "center"];
        linkButton.helpTip = "Link the selected layers to a control null.";
        var helpButton = buttonRow.add("button", undefined, "?");
        helpButton.alignment = ["right", "center"];
        helpButton.preferredSize.width = 30;
        helpButton.helpTip = "How to use " + SCRIPT_NAME;

        var status = win.add("statictext", undefined, "Select layers, then click Link.", { truncate: "end" });
        status.alignment = ["fill", "top"];

        // Restore last-used options.
        propList.selection = choiceIndex(loadSetting("choice", "opacity"));
        (loadSetting("link", "effect") === "transform" ? linkTransform : linkEffect).value = true;
        (loadSetting("mode", "absolute") === "relative" ? modeRel : modeAbs).value = true;
        useNull.value = loadSetting("useExisting", "0") === "1";
        overwrite.value = loadSetting("overwrite", "0") === "1";

        function currentChoice() {
            var sel = propList.selection;
            return (sel && CHOICES[sel.index]) || CHOICES[0];
        }

        function refresh() {
            var c = currentChoice();
            linkEffect.text = c.control + " on the null";
            linkTransform.text = c.id === "selected"
                ? "The null's own transform (where possible)"
                : "The null's own " + c.label;
            hint.text = HINTS[modeRel.value ? "relative" : "absolute"][c.id];
            win.layout.layout(true);
        }

        propList.onChange = refresh;
        linkEffect.onClick = refresh;
        linkTransform.onClick = refresh;
        modeAbs.onClick = refresh;
        modeRel.onClick = refresh;

        linkButton.onClick = function () {
            var opts = {
                choice: currentChoice().id,
                link: linkTransform.value ? "transform" : "effect",
                relative: modeRel.value,
                useExisting: useNull.value,
                overwrite: overwrite.value
            };
            saveSetting("choice", opts.choice);
            saveSetting("link", opts.link);
            saveSetting("mode", opts.relative ? "relative" : "absolute");
            saveSetting("useExisting", opts.useExisting ? "1" : "0");
            saveSetting("overwrite", opts.overwrite ? "1" : "0");

            var result;
            try {
                result = linkSelection(opts);
            } catch (e) {
                if (e.isUserError) {
                    status.text = e.message.split("\n")[0];
                    alert(e.message, SCRIPT_NAME);
                } else {
                    status.text = "Something went wrong - see the message.";
                    alert("Something went wrong:\n" + e.toString() +
                        (e.line ? " (line " + e.line + ")" : "") +
                        "\n\nUse Edit > Undo to revert any partial changes.", SCRIPT_NAME, true);
                }
                status.helpTip = e.message;
                return;
            }
            var message = summarize(result);
            status.text = message;
            status.helpTip = message;
            if (result.warnings.length > 0) {
                alert(message + "\n\n" + result.warnings.join("\n"), SCRIPT_NAME);
            }
        };

        helpButton.onClick = function () {
            alert(HELP_TEXT, SCRIPT_NAME);
        };

        win.onResizing = win.onResize = function () {
            this.layout.resize();
        };

        refresh();
        if (win instanceof Window) {
            win.center();
            win.show();
        } else {
            win.layout.layout(true);
            win.layout.resize();
        }
    }

    buildUI(thisObj);
})(this);
