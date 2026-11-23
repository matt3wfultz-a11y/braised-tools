# Braised Null Linker (After Effects)

A dockable After Effects panel that links the same property on many layers to one control null in one click. For example, select 12 layers, choose **Opacity**, click **Link**, and one slider now fades all of them.

## Install

1. Copy `Braised Null Linker.jsx` into the ScriptUI Panels folder:
   - **macOS:** `/Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/`
   - **Windows:** `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\`
2. Restart After Effects.
3. Open it from **Window > Braised Null Linker.jsx** and dock it wherever you like.

You can also skip installing it and run it once as a floating window from **File > Scripts > Run Script File...**

## Use

1. Select the layers you want to control.
2. Pick a **Property**: Opacity, Rotation, Scale or Position.
3. Pick what it should **Link to** and the **Mode** (see below).
4. Click **Link**.

A null called `CTRL - Opacity` (or whatever you linked) is added just above the top selected layer, and every selected layer gets an expression pointing at it. The null is selected afterwards, so its controls show up straight away in Effect Controls. Each Link is a single undo step.

### Link to

| Option | What gets added |
| --- | --- |
| **Control on the null** | An expression control effect on the null: **Slider** for Opacity and Scale, **Angle** for Rotation, **Point** for Position (a 3D Point if any layer is 3D), **Color** for colours. |
| **The null's own property** | No effect. The layers follow the null's own Opacity, Rotation, Scale or Position. |

### Mode

| Mode | Behaviour |
| --- | --- |
| **Absolute** | Every layer takes the control's value. The control starts at the top layer's current value. Keyframes on the layers are overridden. |
| **Relative** | Each layer keeps its own value and keyframes. The control **multiplies** percentages (Opacity, Scale: 100 = unchanged) and **offsets** everything else (Rotation, Position: 0 = unchanged). Nothing moves when you first link. |

Relative with the null's own Position puts the null in the middle of the layers. Moving the null then moves them all by the same amount.

### Options

- **Use a selected null as the controller.** Select an existing null along with some new layers to hook them up to it instead of making another null. If the null already has a control with the same name (e.g. `Opacity`), that control is reused.
- **Overwrite existing expressions.** When this is off, properties that already have an expression are left alone and listed in the report.

### Selected Properties (anything else)

Choose **Selected Properties**, twirl open your layers, and select the exact properties to drive, using Ctrl/Cmd-click to pick several. This works for effect values (e.g. Gaussian Blur > Blurriness), shape fills and strokes, text animators, X/Y Position, and so on. Each kind of property gets its own control on one null, named after it (e.g. `Gaussian Blur Blurriness`, `Fill 1 Color`). Properties that can't be driven by a number, point or colour, such as Source Text or Path, are skipped and listed.

## Good to know

- You can rename the null or its effects afterwards. After Effects updates the expressions for you.
- Expressions find the null by name, so don't give another layer the same name.
- Layers with **Separate Dimensions** turned on are handled. X/Y/Z Position are linked to the matching part of the control.
- Locked layers, and layers without the property (e.g. a camera has no Opacity), are skipped and listed.
- The expressions work in both the JavaScript and Legacy ExtendScript expression engines.

Example of what gets written (Opacity, Relative, Slider):

```js
value * thisComp.layer("CTRL - Opacity").effect("Opacity")(1).value / 100;
```
