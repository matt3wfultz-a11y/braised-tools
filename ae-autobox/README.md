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
- keeps its padding, min size and anchor. Keyframes on its old look controls
  carry over, hold keys and easing included (a keyframed gradient angle doesn't:
  AutoBox says so).

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

The box doesn't follow its layers frame by frame. It reads each layer's
keyframes (Position, Scale, Rotation, Anchor Point, Opacity, Source Text, text
animator Range Selectors, and those of a nested box or null between the layer
and the box):

- A move that **brings a layer into view** brings it in: it starts clear of where
  it ends up (beyond the padding), or it fades or scales in, or a text animator
  reveals it. The box morphs to fit it, measured where the move ends, on the
  curve of that move. Ease, overshoot and bounce carry over, but overshoot never
  makes the box cut a layer. A move still going when the layer has faded in, or
  a second leg straight after (a path through a middle keyframe), is the rest of
  its way in, unless it heads back out.
- A move that **takes it clear away** (or fades or scales it out) takes it out,
  and so does its out point. The box keeps that space until the next layer comes
  in, then morphs to fit the layers that are in. In a text swap, the box goes from
  the old line's size to the new one's on the new line's curve. If a layer leaves
  while another is still coming in (on its curve, or within Morph Time of
  appearing), that morph refits without it.
- **Smaller moves** (a nudge, a pulse, a slow drift) and **Source Text changes**
  reposition it: the box follows. Lots of little keyframed moves (more than
  eight, like a hand-keyed wiggle) make it hold one shape that covers them all.
- Each layer's part of the box moves on **its own curve**, so staggered layers
  blend smoothly. Layers that come in together give the same box whatever their
  order in the timeline, and a layer that has landed is never cut while a slower
  one is still on its way.
- **Text animators.** One that hides the characters it selects (Opacity or Scale
  at 0, like the Typewriter preset) tells AutoBox how much of the line shows:
  typing on brings the line in, from the start of the line, and erasing takes it
  out. With other animators, a reveal brings the line in and running it back
  takes it out.
- A layer **without keyframes** is in from its in point. If it appears after the
  box starts, the box gets ready for it over **Morph Time** with **Morph Ease**,
  and is there when it appears. Its out point takes it out. Text changes work the
  same way. A layer trimmed past its keyframes appears where they left it.
- A layer that's **on screen from the first frame** and only moves away is in from
  the start. When a layer sits still and then makes one big move, AutoBox checks
  which of its two places matches where that layer was when you made the box, so
  **make the box while your layers are in place**.
- A layer moved by **expressions** (a wiggle, a counter, a rig, an expression on
  top of keyframes), or by **dense keyframes** such as tracking data, is followed
  frame by frame.
- **Grow From** sets how the box first appears: **Motion** grows it from the side
  the first layer comes from (a layer rising from below grows the box up from its
  bottom edge; a layer scaling in grows it from that layer's anchor; a fade finds
  the box already there), **Box Anchor** grows it from that point, **Snap** shows
  it whole. **When Empty** sets what happens when the last layer leaves: **Hold**
  keeps the box, **Collapse** shrinks it away with that layer.

When the automatic reading gets a layer wrong, select it and click **In Box**.
The layer gets an **In Box** menu set to **Auto**. Keyframe it to **In** or **Out** to say
yourself when the layer counts: switching to In just before or during a move
borrows that move's curve, and without a move the box gets ready over Morph Time.
**Skip** leaves the layer out but keeps the layers parented to it (keyframed to
Skip at some point, it never decides for them); nulls, adjustment layers and
guide layers in a box are set to Skip automatically. A layer parented to another
layer in the box is only in while its parent is. In Box is for layers, not
boxes: for a box nested in another, give its layers the menu.

**Freeze** (on the box's Effect Controls) holds the box while it's on, then eases
back over Morph Time. On with no keyframes, it locks the box at its shape on its
last frame.
Turn **Smart Animate** off to have the box wrap its layers on every frame instead.

### Using the box as a track matte

Select a box (or one of its layers) and click **Matte**. Every layer in the box
uses it as its Alpha track matte, so they only show inside the box, and the box
stays visible as their background (made longer if it has to be, to last as long
as they do). Click again to take the mattes off, from layers that have since
left the box too. With several boxes selected, one click turns them all on, or
all off. Remove takes the box off as the matte of a layer it takes out. This
needs After Effects 2023 or newer, where any layer can be a track matte.

The matte is the box as it renders: if the box is see-through (Opacity or Fill
Opacity below 100%, a gradient with see-through color stops) or has effects such as a drop
shadow, its layers fade or show along with it. Matte points this out. For a
see-through or shadowed box, duplicate it, keep the copy fully opaque with no
effects, and use the copy as the matte.

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
| Smart Animate | On: the box morphs as layers come and go (see above). Off: it wraps its layers on every frame. Read at the box's first frame. |
| Grow From | Motion, Box Anchor or Snap: how the box first appears (see above). |
| When Empty | Hold or Collapse: what the box does when its last layer leaves. |
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
- **Remove**: takes the selected layers out of their box. They stay where they
  are, and stay in whatever the box is in (an outer box, a controller null).
- **Select Members**: selects every layer in the selected box.
- **Matte** and **In Box**: see above.
- **Release**: bakes the box's size into plain keyframes and removes AutoBox's
  expressions, controls and In Box menus. The look stays.

### Good to know

- **Riders.** A layer parented to another layer in the box counts too, measured
  where it is. It comes and goes with its parent, and can have its own entrance.
- **Nested boxes.** A box inside a box counts through its layers, grown by its
  padding and stroke, so both boxes move on the same curves. The outer box doesn't
  see the inner box's Min Width/Height or Freeze, and counts its stroke width even
  when you switch the stroke off by its eyeball (set the width to 0 instead).
  A released box counts as a plain layer.
- **Locked layers** are left alone: Apply, Remove, Release and Matte skip them
  and say so. Converting an old box unlocks it and its layers for the moment and
  locks them again.
- **Cameras and lights** parented to a box are ignored. **Nulls**, adjustment and
  guide layers get In Box set to Skip when you Create, Add to or Apply to the box;
  one you parent to a box by hand later needs Apply to Box (or In Box › Skip).
- **Layers are measured by their unrotated bounds** in the box's space. Rotate
  the box itself rather than the layers inside it.
- **The box is 2D.** 3D layers are measured as if they were flat (Z rotation
  only: X/Y rotation, orientation and cameras are ignored).
- **Precomps and footage are measured by their full frame.** Crop a precomp to
  its content (Composition › Crop Comp to Region of Interest), or box the layers
  inside it.
- **Text height can jitter.** The box measures the actual letters, so a line with
  descenders (g, y, p) is a little taller than one without. Set **Min Height** to
  steady it.
- **The box has no motion blur of its own**, because its expressions would run
  for every motion blur sample. It morphs on its layers' curves anyway.
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
