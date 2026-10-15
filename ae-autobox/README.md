# AutoBox for After Effects

Select some layers, click **Create Box**, and AutoBox puts a rounded box behind
them. The box resizes itself as the layers change, and it can arrange the layers
in a vertical or horizontal stack, much like auto layout in Figma.

- **Padding**: one value for every side, plus an extra amount for each side
- **Rounded corners**: the radius is capped at half the box's shorter side
- **Layout**: Free (the box wraps the layers wherever they are), Vertical stack or Horizontal stack, with gap, align and justify
- **Live**: edit text, scale or animate a layer and the box and stack follow on every frame
- **Keyframeable**: every setting is on the box layer's Effect Controls
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

## Use

1. Select the layers you want boxed: text, shapes, footage or precomps.
2. In the panel, pick a layout, padding and corner radius.
3. Click **Create Box**.

AutoBox adds a shape layer named `AutoBox 1` directly below the lowest selected
layer. It parents the selected layers to it, so moving, scaling or rotating the
box moves the whole group. After that you edit the box in **Effect Controls**:

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
| Fill Color / Fill Opacity | The box fill. |
| Stroke Width / Stroke Color | The outline. 0 means no stroke. |
| Ignore Hidden | When on, layers that are switched off or outside their in/out points don't take up space. |

The panel's values are the **defaults for new boxes**. **Apply to Box** pushes
them onto the selected box or boxes.

Other buttons:

- **Add to Box**: select a box and some other layers to add those layers to it.
- **Remove**: takes the selected layers out of their box. They stay where they are.
- **Select Members**: selects every layer in the selected box.
- **Release**: bakes the layout into plain values and keyframes, then removes
  the rig. The layers stop updating automatically.

### Good to know

- **Renaming layers is fine.** AutoBox finds layers by name, and After Effects
  updates those references when you rename a layer. If two selected layers share
  a name, AutoBox renames one of them (for example to `Title 2`) when it creates
  the box. It also gives text layers a fixed name, so editing the text doesn't
  rename them.
- **Want another box like this one?** Run Create Box again, or duplicate the
  whole comp. Duplicating just the box and its layers leaves the copies pointing
  at the originals.
- **Parented layers ride along.** A layer parented to another member moves with
  its parent instead of taking its own spot in a stack. Use a nested box when you
  want a row inside a column.
- **Stacks use each layer's unrotated bounds.** Rotate the box itself, not the
  layers inside it.
- **The box is 2D.** 3D layers are measured as if they were flat.
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
the real `AutoBox.jsx`. The tests check the box and stack positions down to the
pixel, and make sure the expression code is plain ES3 so the Legacy ExtendScript
engine can run it. The CEP panel is tested by loading `cep/index.html` in jsdom,
with its evalScript calls routed into that same mock.

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
