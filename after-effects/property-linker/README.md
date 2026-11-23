# Property Linker (After Effects)

Link the same property on many layers to one slider in one click. For example, select 12 layers, choose **Opacity**, click **Link**, and a single Slider Control now fades all of them.

The slider lives on a small control null (e.g. `Opacity Control`). The null only holds the control. Nothing is parented to it, and nulls never render.

## Install

1. Download [`dist/PropertyLinker-1.0.0.zxp`](dist/PropertyLinker-1.0.0.zxp).
2. Open the **aescripts ZXP Installer** and drag the `.zxp` onto it. Any ZXP installer or Adobe's `ExManCmd` also works.
3. Restart After Effects.
4. Open **Window > Extensions > Property Linker** and dock it wherever you like. In some newer versions the menu is called *Extensions (Legacy)*.

Works in After Effects CC 2019 (16.0) and later.

## Use

1. Select the layers you want to control.
2. Pick a **Property**: Opacity, Rotation, Scale or Position.
3. Pick a **Mode**: Absolute or Relative.
4. Click **Link**.

| Property | Control added to the null |
| --- | --- |
| Opacity | Slider Control |
| Rotation | Angle Control |
| Scale | Slider Control (uniform scale) |
| Position | Point Control (3D Point Control if any layer is 3D) |

The null is placed just above the top selected layer and selected afterwards, so its control shows up straight away in Effect Controls. Each Link is a single undo step.

### Mode

| Mode | Behaviour |
| --- | --- |
| **Absolute** | Every layer takes the control's value. The control starts at the top layer's current value. Keyframes on the layers are overridden. |
| **Relative** | Each layer keeps its own value and keyframes. The control **multiplies** percentages (Opacity, Scale: 100 = unchanged) and **adds** to everything else (Rotation, Position: 0 = unchanged). Nothing changes when you first link. |

### Options

- **Add to the selected control null.** Forgot a layer? Select the control null along with the new layers and click Link. The new layers are hooked up to the same control.
- **Overwrite existing expressions.** When this is off, properties that already have an expression are left alone and listed in the panel.

### Selected Properties (anything else)

Choose **Selected Properties**, twirl open your layers, and select the exact properties to drive, using Ctrl/Cmd-click to pick several. This works for effect values (e.g. Gaussian Blur > Blurriness), shape fills and strokes, text animators, X/Y Position, and so on. Each kind of property gets its own control on one null, named after it (e.g. `Gaussian Blur Blurriness`, `Fill 1 Color`). Properties that can't be driven by a number, point or colour, such as Source Text or Path, are skipped and listed.

## Good to know

- You can rename the null or its controls afterwards. After Effects updates the expressions for you.
- Expressions find the null by name, so don't give another layer the same name.
- Layers with **Separate Dimensions** turned on are handled.
- Locked layers, and layers without the property (e.g. a camera has no Opacity), are skipped and listed.
- The expressions work in both the JavaScript and Legacy ExtendScript expression engines. For example, Opacity in Relative mode writes:

  ```js
  value * thisComp.layer("Opacity Control").effect("Opacity")(1).value / 100;
  ```

## Building the ZXP

The panel's source is in `extension/`:

| Path | What it is |
| --- | --- |
| `CSXS/manifest.xml` | CEP extension manifest (id, version, supported After Effects versions) |
| `index.html`, `css/`, `js/panel.js` | The panel UI |
| `jsx/property-linker.jsx` | The After Effects side that does the linking (ExtendScript, ES3) |

After changing anything, bump `ExtensionBundleVersion` in `CSXS/manifest.xml`, then run:

```bash
python3 build.py
```

This writes a signed `dist/PropertyLinker-<version>.zxp`. It needs only Python 3 and `openssl`, both of which come with macOS. The first build creates a self-signed certificate in `.signing/`, which is git-ignored, so keep that folder private. To sign with your own certificate, use `python3 build.py --key key.pem --cert cert.pem`.

To try changes without packaging, you can load the `extension/` folder unsigned. Turn on CEP debug mode and symlink the folder into Adobe's CEP `extensions` folder.
