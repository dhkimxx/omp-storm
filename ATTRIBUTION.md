# Attribution and licences

This branch holds artwork and the sources to render it. It is separate from `main`, whose code is MIT
licensed; the files below keep the licences they came with.

## Model marks: Lobe Icons (MIT)

The six marks in the banner (OpenAI, Claude, Gemini, Grok, DeepSeek, Qwen) are SVGs from
[Lobe Icons](https://github.com/lobehub/lobe-icons) by LobeHub, commit
`05260484d9f4de68f90cc87a634ae68fa4043efd`, MIT, `Copyright (c) 2023 LobeHub`.
The full licence text is in [`LICENSE-lobe-icons.txt`](LICENSE-lobe-icons.txt) (also kept beside the SVGs in
`banner/assets/`). Exact source URLs and SHA-256 hashes: [`banner/assets/sources.json`](banner/assets/sources.json).

The marks decorate the banner. They do not say OMP Storm was tested with, endorsed by or affiliated with those
products. The logos and names identify their respective owners.

## Banner lettering: Nimbus Sans (AGPL-3 with font exception)

The words OMP, STORM and MULTI-AGENT ORCHESTRATION are set in Nimbus Sans Bold and Regular from
[urw-base35-fonts](https://github.com/ArtifexSoftware/urw-base35-fonts) (tag `20200910`), `Copyright 2015 URW
Software; 2013, 2014 (URW)++ Design & Development`, licensed under the GNU Affero General Public License
version 3 with the font exception stated in [`FONT-COPYRIGHT.txt`](FONT-COPYRIGHT.txt), which also contains the
complete AGPL-3 text. The two `.otf` files in `banner/assets/` are byte-identical to that tag's
`fonts/NimbusSans-Bold.otf` and `fonts/NimbusSans-Regular.otf`; the complete source of those files is the
upstream repository at that tag.

The AGPL-3 applies to the font files, not to the rest of this branch. The MIT licence of `main` does not cover them.

## Banner render scripts

`banner/render.cjs`, `banner/title-effect.cjs`, `banner/encode-gif.cjs` and `banner/encode-webp.sh` draw and
encode the banner. They are the project author's artwork sources; the two runtime packages (`@napi-rs/canvas`,
`sharp`) are fetched by `npm install` and are not stored here.
