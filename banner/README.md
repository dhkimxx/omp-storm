# OMP Storm banner: render sources

Procedural storm with six model marks handing signals to each other and a gradient sweeping through the title.
8 seconds, seamless loop. Licences and credits: `../ATTRIBUTION.md`.

Needs Node.js, `ffmpeg` and `img2webp` (libwebp tools). From this directory:

```sh
npm install                 # @napi-rs/canvas 0.1.100, sharp 0.35.5 (see package-lock.json)
npm run preview             # still frames + loop check into output/
sh encode-webp.sh           # ../storm-cyclone.webp: 1200 x 450, 24 fps, 192 frames, lossy q63 (about 3 MB)
node render.cjs --preview && cp output/poster.png ../storm-cyclone.png   # the 1600 x 600 still
```

`npm run render` and `npm run gif` still make the original 1600 x 600, 30 fps MP4 and the (very large) GIF.

Changes from the original v2 renderer: the OMP and MULTI-AGENT ORCHESTRATION labels are larger so they stay
readable at README width (`title-effect.cjs`), and `render.cjs --frames <dir> --fps N` writes PNG frames at an
even frame rate (used for the WebP).
