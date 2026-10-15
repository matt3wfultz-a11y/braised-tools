# AutoBox for After Effects

Select some layers, click **Create Box**, and AutoBox puts a rounded box behind
them. The box resizes itself as the layers change, and it can arrange the layers
in a vertical or horizontal stack, much like auto layout in Figma.

- **Padding**: one value for every side, plus an extra amount for each side
- **Rounded corners**: the radius is capped at half the box's shorter side
- **Layout**: Free (the box wraps the layers wherever they are), Vertical stack or Horizontal stack, with gap, align and justify
- **Fill and stroke**: solid colors, or linear and radial gradients that stretch with the box
- **Live**: edit text, scale or animate a layer and the box and stack follow on every frame
- **Keyframeable**: every setting, colors included, is on the box layer's Effect Controls
- **Nesting**: a box can sit inside another box (for example an icon and title row inside a card)

Works in After Effects 2020 (17.0.1) and newer, on macOS and Windows, with
either the JavaScript or the Legacy ExtendScript expression engine.

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

### Upgrading from 1.0

Boxes made with AutoBox 1.0 keep working. To give one the 2.0 engine
(gradients, and no more breaking when text changes), select it and click
**Apply to Box**. The first click only upgrades the box and keeps its settings.
Click again if you also want to apply the panel's settings to it.

## Use

1. Select the layers you want boxed: text, shapes, footage or precomps.
2. In the panel, pick a layout, padding, corner radius, fill and stroke.
3. Click **Create Box**.

AutoBox adds a shape layer named `AutoBox 1` directly below the lowest selected
layer, plus an `AutoBox 1 Stroke` layer just above it that draws the outline.
It parents the selected layers to the box, so moving, scaling or rotating the
box moves the whole group.

**Any layer parented to a box is in that box.** Because AutoBox follows parenting
rather than layer names, editing text, renaming, reordering and duplicating
layers never break a box. To add layers, use **Add to Box**. Pick-whipping a layer
to a box also works, but in a stack, click **Apply to Box** afterwards so the
layer moves into its spot. To take layers out, use **Remove**, which keeps them
where they are. Plain unparenting can make a stacked layer jump.

If the layers you box are parented to something, such as a controller null or
another box they sit in, the new box is parented to it instead. The controller
keeps working, and a box made from layers inside a box is nested in it.

### The panel

The panel is laid out like After Effects' own Effect Controls:

- **Blue values** work like After Effects' hot text. Drag left or right to change
  them (**Shift** for bigger steps, **Ctrl/Cmd** for finer ones), or click to type
  (Enter to apply, Esc to cancel, Tab to move to the next value). Arrow keys
  nudge a focused value.
- Click the **triangle** next to a value to open its slider.
- Each section has a **Reset** link that restores its defaults.
- **Fill** and **Stroke** switch between a color swatch and a gradient bar. Click a
  swatch or a gradient stop to pick a color; ⇄ swaps the gradient's colors. Set a
  linear gradient's direction with the angle dial (0° is up, 90° runs left to
  right).

The panel's values are the **defaults for new boxes**. **Apply to Box** pushes
them onto the selected box or boxes. Controls you have keyframed are left
alone.

### Effect Controls

After that, you edit a box in its **Effect Controls**:

| Control | What it does |
| --- | --- |
| Layout | **Free (wrap)** keeps the layers where you put them. **Vertical Stack** and **Horizontal Stack** arrange them in timeline order, top layer first. Reorder the layers in the timeline to reorder the stack. |
| Gap | Space between stacked layers. |
| Align | Cross-axis alignment: left/center/right in a vertical stack, top/center/bottom in a horizontal one. |
| Justify | Where the stack sits along its main axis when the box is bigger than its contents (see Min Width/Height). Space Between spreads the items out. |
| Box Anchor | The point of the box that stays put while it grows. For example, Left grows to the right and Center grows evenly in both directions. |
| Padding | Space between the contents and the edge of the box. |
| Extra Top / Right / Bottom / Left | Added to Padding on that side. |
| Corner Radius | Corner rounding, capped at half the box's shorter side. |
| Min Width / Min Height | The smallest the box may get. 0 means it fits the contents. |
| Ignore Hidden | When on, layers that are switched off or outside their in/out points don't take up space. |
| Fill Type | Solid, Linear Gradient or Radial Gradient. |
| Fill Color / Fill Color 2 | The solid color, or the gradient's start and end colors. |
| Fill Angle | Direction of a linear gradient (0° up, 90° left to right). The gradient always spans the box. |
| Fill Opacity | |
| Stroke Width | 0 means no stroke. |
| Stroke Type, Stroke Color / Color 2, Stroke Angle, Stroke Opacity | As for the fill. A gradient stroke spans the stroke's outer edge. |

Other buttons:

- **Add to Box**: select a box and some other layers to add those layers to it.
- **Remove**: takes the selected layers out of their box. They stay where they are.
- **Select Members**: selects every layer in the selected box.
- **Release**: bakes the layout into plain values and keyframes, then removes
  the layout rig. The fill, stroke and their controls stay.

### Good to know

- **How gradients work.** After Effects doesn't let scripts or expressions set
  gradient colors. So AutoBox draws After Effects' own gradient (left at its
  default white to black) and recolors it with a **Tint** effect linked to the
  color controls. That's why the colors are live and keyframeable. Change gradient
  colors in Effect Controls, not with Edit Gradient, which Tint would recolor
  again. Gradients have two colors.
- **The stroke is its own layer** (`AutoBox 1 Stroke`), so the fill and the stroke
  can each have their own gradient. It follows the box's position, scale, rotation,
  opacity and visibility automatically. A solid stroke on a solid fill is drawn
  in the box itself instead, so the two fade together. Effects, blending modes
  and track mattes on the box don't reach the stroke layer. While a box with a
  gradient stroke fades, the inner half of the stroke can look slightly different.
  To put an effect such as Drop Shadow on the whole box, or to get a perfect fade,
  precompose it.
- **Want another box like this one?** Run Create Box again, or duplicate the box
  together with its layers and stroke layer. If you duplicate, make sure the copies
  are parented to the copied box: any layer parented to a box belongs to it.
- **Parented layers ride along.** A layer parented to another member moves with
  its parent instead of taking its own spot in a stack. Use a nested box when you
  want a row inside a column.
- **Don't parent nulls, cameras or lights to a box.** Cameras and lights are
  ignored. A null can't be told apart from a regular layer, so it would be
  measured as a 100×100 layer. Parent the box to the null instead.
- **Stacks use each layer's unrotated bounds.** Rotate the box itself, not the
  layers inside it.
- **The box is 2D.** 3D layers are measured as if they were flat. In a comp
  with a camera, 3D members won't line up with the box, so keep boxed layers 2D
  or precompose them.
- **Precomps and footage are measured by their full frame.** Crop a precomp to
  its content (Composition › Crop Comp to Region of Interest), or box the layers
  inside it.
- **The eyedropper in the color picker can be off.** After Effects' color picker
  sometimes returns the wrong color for sampled colors. If a picked color looks
  wrong, fix it in the box's color controls in Effect Controls.
- **Text height can jitter.** The box measures the actual letters, so a line with
  descenders (g, y, p) is a little taller than one without. If that shows while
  text animates, set **Min Height** to steady it.

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
gradient colors scripts can't touch, and expression cycles. The tests check box,
stack and gradient positions down to the pixel, and parse every expression
AutoBox writes as plain ES3 for the Legacy ExtendScript engine. The CEP panel is
tested in jsdom, with its evalScript calls routed into that same mock.

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
