/** Tạo icon PWA từ SVG — chạy: npx tsx scripts/make-icons.ts */
import sharp from "sharp";
import { mkdirSync } from "node:fs";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fbbf24"/>
      <stop offset="55%" stop-color="#fb923c"/>
      <stop offset="100%" stop-color="#f43f5e"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity=".35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="#0b0b14"/>
  <rect x="24" y="24" width="464" height="464" rx="96" fill="url(#bg)"/>
  <rect x="24" y="24" width="464" height="200" rx="96" fill="url(#gloss)" opacity=".5"/>
  <!-- sóng âm -->
  <g stroke="#0b0b14" stroke-width="34" stroke-linecap="round" fill="none">
    <path d="M 150 256 v 0" opacity=".9"/>
    <path d="M 208 208 v 96" opacity=".75"/>
    <path d="M 266 160 v 192"/>
    <path d="M 324 208 v 96" opacity=".75"/>
    <path d="M 382 256 v 0" opacity=".9"/>
  </g>
</svg>`;

mkdirSync("public/icons", { recursive: true });

for (const size of [192, 512]) {
  await sharp(Buffer.from(svg)).resize(size, size).png().toFile(`public/icons/icon-${size}.png`);
  console.log(`✓ public/icons/icon-${size}.png`);
}
// maskable: logo nhỏ hơn, đệm an toàn 20%
const maskable = svg.replace(
  'x="24" y="24" width="464" height="464"',
  'x="84" y="84" width="344" height="344"',
);
await sharp(Buffer.from(maskable)).resize(512, 512).png().toFile("public/icons/icon-maskable-512.png");
console.log("✓ public/icons/icon-maskable-512.png");
// favicon thay thế
await sharp(Buffer.from(svg)).resize(64, 64).png().toFile("public/icons/favicon-64.png");
console.log("✓ public/icons/favicon-64.png");
