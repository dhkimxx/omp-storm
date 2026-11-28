/**
 * Previews key SVGs side by side, zoomed, on the night sky (base tinted ice, accent amber), without a bake:
 *
 *   bun scripts/stage/art/owl-starling/peek.ts OUT.png ZOOM KEY.svg...
 */
import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync } from "node:fs";

const [out, zoomArg, ...files] = process.argv.slice(2);
if (out === undefined || zoomArg === undefined || files.length === 0) throw new Error("usage: peek.ts OUT.png ZOOM KEY.svg...");
const zoom = Number(zoomArg);
let x = 0;
let H = 0;
const parts = files.map((file, i) => {
	let svg = readFileSync(file, "utf8");
	const w = Number(svg.match(/width="(\d+)"/)?.[1]);
	const h = Number(svg.match(/height="(\d+)"/)?.[1]);
	// Each SVG keeps its own ids: suffix them so the documents do not share clip paths and gradients.
	const tag = "abcdefghijklmnopqrstuvwxyz"[i];
	svg = svg.replace(/id="(\w+)"/g, `id="$1${tag}"`).replace(/url\(#(\w+)\)/g, `url(#$1${tag})`);
	svg = svg.replace(/<svg[^>]*>/, `<svg x="${x}" y="0" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden"><rect width="${w}" height="${h}" fill="rgb(7,10,24)"/>`);
	svg = svg.replace(/<g id="accent\w">/, '<g filter="url(#amb)">');
	svg = svg.replace(/<g opacity="1"/, '<g filter="url(#ice)" opacity="1"');
	x += w + 2;
	H = Math.max(H, h);
	return svg;
});
const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${x * zoom}" height="${H * zoom}" viewBox="0 0 ${x} ${H}">
<defs><filter id="amb"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0.68 0 0 0  0 0 0.22 0 0  0 0 0 1 0"/></filter>
<filter id="ice"><feColorMatrix type="matrix" values="0.6 0 0 0 0  0 0.8 0 0 0  0 0 1 0 0  0 0 0 1 0"/></filter></defs>
<rect width="${x}" height="${H}" fill="rgb(20,20,30)"/>${parts.join("\n")}</svg>`;
writeFileSync(out, new Resvg(doc, { font: { loadSystemFonts: false } }).render().asPng());
