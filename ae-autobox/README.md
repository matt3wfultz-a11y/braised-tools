# AutoBox for After Effects

Select some layers, click **Create Box**, and AutoBox puts a rounded box behind
them. Animate the layers however you like: the box animates to fit the layers
coming in, using their own keyframe curves, and holds still while layers leave.
That means the box can be their track matte.

- **No expressions on your layers.** Position, Scale, everything stays native
  and keyframeable. Only the box itself carries expressions.
- **Smart Animate**: the box reads your keyframes. A layer sliding in makes the
  box grow on that slide's easing (overshoot and bounce included). A layer
  sliding out leaves the box where it is until the next layer comes in.
- **Native look**: fill, stroke, gradients and corner roundness are the box's own
  shape properties, edited in its Contents. Gradients stretch with the box.
- **Padding, min size and anchor** are on the box's Effect Controls, all
  keyframeable.
- **Matte** sets the box as its layers' track matte in one click.
- **Nesting**: a box can sit inside another box, and the outer box follows the
  inner box's animation.

Works in After Effects 2020 (17.0.1) and newer, on macOS and Windows, with
either the JavaScript or the Legacy ExtendScript expression engine. **Matte**
needs After Effects 2023 (23.0) or newer.

## Install

### ZXP (recommended)

1. Download [`dist/AutoBox.zxp`](dist/AutoBox.zxp).
2. Open it with [ZXP Installer](https://aescripts.com/learn/zxp-installer/) (or Anastasiy's Extension Manager).
3. Restart After Effects and open **Window › Extensions › AutoBox**
   (named **Extensions (Legacy)** in some newer versions).

The ZXP is signed with a self-signed Braised Animation certificate that is
valid until 2046.

### Script panel (no installer)

Copy [`AutoBox.jsx`](AutoBox.jsx) into After Effects' `Scripts/ScriptUI Panels`
folder and restart. It appears as **Window › AutoBox.jsx**. Both versions run
the same code and make the same boxes.

### Boxes made with AutoBox 1 or 2

Old boxes keep working as they are. To give one the 3.0 rig, select it and click
**Apply to Box** (or **Add to Box**). AutoBox asks first, then:

- removes the old expressions from its layers, leaving every layer where it is
  (a stack becomes plain layers you can arrange with the Align panel);
- turns its fill and stroke into native shape properties with the same colors,
  widths and corner radius, and removes its Tint effect and its separate
  stroke layer. Scripts can't set gradient colors, so a gradient goes back to
  white and black: set it again with Edit Gradient;
- keeps its padding, min size and anchor.

The first click only converts. Click **Apply to Box** again to apply the panel's
settings. Boxes from AutoBox 1.0 can also track layers that are parented to
something else; AutoBox asks whether to parent those to the box.

## Use

1. Select the layers you want boxed: text, shapes, footage or precomps.
2. In the panel, set padding, corner radius, fill and stroke.
3. Click **Create Box**.

AutoBox adds a shape layer named `AutoBox 1` directly below the lowest selected
layer and parents the selected layers to it, so moving, scaling or rotating the
box moves the whole group.

**Any layer parented to a box is in that box.** Because AutoBox follows parenting
rather than layer names, editing text, renaming, reordering and duplicating
layers never break a box. Use **Add to Box** and **Remove** to change what's in
a box (pick-whipping a layer to a box works too). Remove keeps layers where
they are.

If the layers you box are parented to something, such as a controller null or
another box they sit in, the new box is parented to it instead. A box made from
layers inside a box is nested in it.

### How the box animates (Smart Animate)

The box doesn't follow its layers frame by frame. It looks at each layer's
keyframes (Position, Scale, Rotation, Anchor Point, Opacity, text animator
Range Selectors, and those of any parent between the layer and the box):

- A layer's **first move brings it in**. The box morphs to fit it, measured
  where the move ends, on the curve of that move. Ease, overshoot and bounce
  carry over.
- Its **last move takes it out** (when it has two or more). The box doesn't
  shrink: it keeps that space until the next layer comes in, then morphs to fit
  the layers that are in. In a text swap, the box goes straight from the old
  line's size to the new one's, on the new line's curve.
- **Moves in between reposition it**, and the box follows on that move's curve.
- A layer **without keyframes** is in from its in point. If it appears after
  the box starts, the box morphs to fit it over **Morph Time** with **Morph
  Ease**. Its out point takes it out.
- **Source Text keyframes** resize the box (over Morph Time) while the layer is
  in.
- The **first** layer in grows the box from **Box Anchor** (for example from the
  center, or from the left edge).

When the automatic reading gets a layer wrong (say a layer that's in place from
the start and only slides out), select it and click **In Box**. The layer gets
an **In Box** checkbox, keyed to match what AutoBox was doing, so nothing
changes yet. Then edit the keys: the layer counts only while In Box is on.
Turning it on in the middle of a move borrows the rest of that move's curve.
Off from the start, the layer never changes the box.

**Freeze** (on the box's Effect Controls) holds the box while it's on, then eases
back to where the box should be over Morph Time. Turn **Smart Animate** off to
have the box wrap its layers on every frame instead.

### Using the box as a track matte

Select a box (or one of its layers) and click **Matte**. Every layer in the box
uses it as its Alpha track matte, so they only show inside the box, and the box
stays visible as their background. Click again to take the mattes off. This needs
After Effects 2023 or newer, where any layer can be a track matte.

### The box's look

Open the box layer's **Contents › AutoBox**:

| Item | |
| --- | --- |
| Box Rect | Size and Position are AutoBox's. **Roundness** is the corner radius (After Effects caps it at half the shorter side). |
| Stroke, Gradient Stroke | Native strokes, above the fills. |
| Fill, Gradient Fill | Native fills. |

The panel switches on the ones you pick and turns the others off with their
eyeball, so you can also switch between them by hand. Colors, widths, opacity,
line joins and dashes are all yours to change and animate. The panel never
changes anything you've keyframed.

**Gradients stretch with the box.** Their Start Point and End Point are
percentages of the box: 0,0 is the center, −50,0 the left edge, 50,−50 the
top-right corner. Scripts can't set gradient colors, so a new gradient is After
Effects' default white to black. Click **Edit Gradient** to set it (with as many
stops as you like).

### Effect Controls

| Control | What it does |
| --- | --- |
| Padding | Space between the layers and the edge of the box. |
| Extra Top / Right / Bottom / Left | Added to Padding on that side. |
| Min Width / Min Height | The smallest the box may get. 0 means it fits the layers. |
| Box Anchor | The point of the box that stays put when Min Width/Height make it bigger, and where it grows from when the first layer comes in. |
| Ignore Hidden | When on, layers whose video switch is off don't count. |
| Smart Animate | On: the box morphs as layers come and go (see above). Off: it wraps its layers on every frame. |
| Morph Time | How long the box takes to fit a layer that has no keyframes to follow (seconds). Also used after Freeze. |
| Morph Ease | Linear, Ease In, Ease Out or Ease In Out, for those morphs. |
| Freeze | While on, the box holds its shape. |

### The panel

The panel is laid out like After Effects' own Effect Controls:

- **Blue values** work like After Effects' hot text. Drag left or right to change
  them (**Shift** for bigger steps, **Ctrl/Cmd** for finer ones), or click to type
  (Enter to apply, Esc to cancel, Tab to move to the next value). Arrow keys
  nudge a focused value.
- Click the **triangle** next to a value to open its slider.
- Each section has a **Reset** link that restores its defaults.

Its values are the **defaults for new boxes**. **Apply to Box** pushes them onto
the selected box or boxes, leaving anything you've keyframed alone.

Other buttons:

- **Add to Box**: select a box and some other layers to add those layers to it.
- **Remove**: takes the selected layers out of their box. They stay where they are.
- **Select Members**: selects every layer in the selected box.
- **Matte** and **In Box**: see above.
- **Release**: bakes the box's size into plain keyframes and removes AutoBox's
  expressions, controls and In Box checkboxes. The look stays.

### Good to know

- **Riders.** A layer parented to another layer in the box counts too, measured
  where it is. It moves in and out with its parent's keyframes.
- **Don't parent nulls, cameras or lights to a box.** Cameras and lights are
  ignored. A null can't be told apart from a regular layer, so it would be
  measured as a 100×100 layer. Parent the box to the null instead.
- **Layers are measured by their unrotated bounds** in the box's space. Rotate
  the box itself rather than the layers inside it.
- **The box is 2D.** 3D layers are measured as if they were flat.
- **Precomps and footage are measured by their full frame.** Crop a precomp to
  its content (Composition › Crop Comp to Region of Interest), or box the layers
  inside it.
- **Text height can jitter.** The box measures the actual letters, so a line with
  descenders (g, y, p) is a little taller than one without. Set **Min Height** to
  steady it.
- **Expressions on your layers' transforms** (a wiggle, say) aren't keyframes,
  so they don't bring a layer in or out. With Smart Animate the box measures the
  layer where it settles, not where the wiggle puts it.
- **Many layers or long animations** make the box's expressions work harder. If
  playback slows down, turn on Freeze for stretches where nothing changes, or
  Release a finished box.

## Development

```sh
npm install
npm test           # Node tests: AE scripting/expression mock + CEP panel in jsdom
npm run build:zxp  # stage, sign and verify dist/AutoBox.zxp
```

After Effects can't run in CI, so `test/ae-mock.js` stands in for it. It mocks
just enough of AE's scripting objects, the expression runtime and ScriptUI to run
the real `AutoBox.jsx`. It models AE's quirks that matter here: text layers that
rename themselves as their text changes, property references that go stale,
shape items that can't safely be reordered, gradient colors scripts can't touch,
`sourceRectAtTime` reading its time as layer time, X/Y Position that can't be
read unless separated, hold-only checkboxes, eased keyframes, track mattes and
expression cycles. The tests check box sizes and curves down to the pixel, and
parse every expression AutoBox writes as plain ES3 for the Legacy ExtendScript
engine. `test/fixtures` holds AutoBox 1.0 and 2.0.1, which the tests use to make
old boxes and convert them. The CEP panel is tested in jsdom, with its
evalScript calls routed into that same mock.

To build the ZXP you need Adobe's `ZXPSignCmd`. Either set `ZXPSIGNCMD` to its
path, or run `npm install --no-save zxp-provider` to get Adobe's macOS and Windows
builds. On Linux, the Windows build runs under Wine (set `WINE` if it isn't on
your `PATH`). On the first build, the script creates a self-signed certificate at
`cert/autobox.p12` (git-ignored). To sign with your own certificate, set
`ZXP_CERT` and `ZXP_CERT_PASSWORD`.

```
AutoBox.jsx          the engine + ScriptUI panel (also bundled into the ZXP)
cep/                 CEP panel: CSXS/manifest.xml, index.html, css/, js/
scripts/build-zxp.js stages cep/ + AutoBox.jsx, signs, verifies
dist/AutoBox.zxp     the signed extension
test/                mock After Effects + tests
```
