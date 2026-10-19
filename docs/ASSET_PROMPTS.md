# WhiteMood 正式网站艺术素材生成说明

工具：内置 imagegen。素材由用户于 2026-10-19 在网页预览确认。运行时只使用最终选定的透明云朵与淡云丝天空，控件均为独立原生组件。

## 透明云朵边缘修复提示词

```text
Use case: precise-object-edit.
Asset type: standalone transparent WhiteMood plush cloud mascot artwork, production RGBA PNG.
Input image 1 (edit target): existing transparent mascot / WhiteMood_云朵IP_网站透明素材.png. Input image 2 (identity reference only): approved WhiteMood_云朵IP_立体光泽版.png.
Primary request: correct ONLY the hard, white board-like cutout perimeter of image 1. The current transparent artwork has an opaque pasted-on white rim and coarse jagged outline. Replace that faulty perimeter with a genuinely soft, natural high-quality fine wool-fibre edge, including sparse individual curly white fibres with finely graded partial alpha. It must integrate convincingly against a pale blue real sky without a solid white halo, white plate, jagged hard boundary, blue matte or rectangular residue.
Preserve the entire existing mascot interior, face, eyes, glossy blue-grey facial parts, little smile, blush, creamy curly fleece, frontal pose, silhouette proportions and existing light direction. Same exact character identity as reference 2. Do not redesign, enlarge the head, change the mouth, change facial material, change wool texture, or add another cloud.
Only the outermost few pixels / flyaway hairs and their alpha transition are to be improved. Do NOT blur the cloud body or melt its silhouette. Preserve wool detail. No new exterior glow.
Actual transparent background required. No opaque background, no checkerboard painted in, no blue sky in the pixels, no ground, no detached shadow, no text, no interface. One full cloud only with transparent padding.
```

## 淡云丝天空提示词

```text
Use case: precise-object-edit.
Asset type: WhiteMood website background sky artwork, no interface.
Edit target: the attached pastel sky background.
Latest user instruction: the background clouds must be MUCH FEWER and should be only PALE, BARELY VISIBLE, THIN WISPY CLOUD THREADS (淡淡的、若隐若现的云丝).
Keep the current gentle milky pale-blue palette, comforting warm daylight and refined soft atmosphere. REMOVE ALL large fluffy cumulus clouds and all heavy white cloud banks along every edge, especially the bottom. Replace those regions with open pale milk-blue sky continuous with the center.
The final image should be approximately 95% clear airy pastel blue sky, with only two or three extremely faint, fine, feather-like cirrus wisps at widely separated outer regions. Very subtle white filaments, a few soft threads rather than cloud masses. The wisps must be low contrast and almost disappear into the blue. Center remains clean and empty for a separately rendered mascot and readable native controls. Wide landscape; simple, spacious, warm, a little dreamy and cute, still recognizable as a sky.
No cumulus, no cotton ball clouds, no bank at the bottom, no busy cloud border, no dense cirrus streaks, no saturated blue, no sun disc, no stars, no horizon, no ground, no objects, no faces, no mascot, no typography, no website UI, no frame. Do not turn it into a flat featureless solid fill: retain a very delicate atmospheric sky gradation and those sparse translucent cloud threads.
```
