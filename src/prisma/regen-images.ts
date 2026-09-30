/**
 * Tạo lại ảnh placeholder với mesh gradient + minh họa loa đẹp hơn.
 * Chỉ ghi đè file SVG trong public/img/listings — không đụng database.
 * Chạy: npx tsx src/prisma/regen-images.ts
 */
import { writeFileSync } from "node:fs";

function makeSvg(label: string, hue: number): string {
  const h = hue;
  const h2 = (hue + 40) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <radialGradient id="m1" cx="20%" cy="15%" r="80%">
      <stop offset="0%" stop-color="hsl(${h}, 85%, 38%)" stop-opacity=".55"/>
      <stop offset="100%" stop-color="hsl(${h}, 85%, 38%)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="m2" cx="85%" cy="25%" r="70%">
      <stop offset="0%" stop-color="hsl(${h2}, 80%, 45%)" stop-opacity=".4"/>
      <stop offset="100%" stop-color="hsl(${h2}, 80%, 45%)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="m3" cx="50%" cy="100%" r="80%">
      <stop offset="0%" stop-color="hsl(${(h + 300) % 360}, 75%, 42%)" stop-opacity=".35"/>
      <stop offset="100%" stop-color="hsl(${(h + 300) % 360}, 75%, 42%)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cab" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${h}, 22%, 22%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 25%, 11%)"/>
    </linearGradient>
    <linearGradient id="cone" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${h}, 18%, 30%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 20%, 14%)"/>
    </linearGradient>
    <radialGradient id="dust" cx="50%" cy="42%" r="60%">
      <stop offset="0%" stop-color="hsl(${h}, 35%, 52%)" stop-opacity=".9"/>
      <stop offset="100%" stop-color="hsl(${h}, 30%, 20%)" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#07070e" stop-opacity="0"/>
      <stop offset="100%" stop-color="#07070e" stop-opacity=".92"/>
    </linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="26"/></filter>
  </defs>

  <rect width="800" height="600" fill="#0b0b14"/>
  <rect width="800" height="600" fill="url(#m1)"/>
  <rect width="800" height="600" fill="url(#m2)"/>
  <rect width="800" height="600" fill="url(#m3)"/>

  <!-- thùng loa -->
  <g transform="translate(400,268)">
    <ellipse cx="0" cy="185" rx="150" ry="26" fill="hsl(${h}, 60%, 45%)" opacity=".28" filter="url(#blur)"/>
    <rect x="-128" y="-158" width="256" height="316" rx="26" fill="url(#cab)" stroke="hsl(${h}, 30%, 38%)" stroke-width="2.5"/>
    <rect x="-128" y="-158" width="256" height="46" rx="26" fill="#ffffff" opacity=".05"/>
    <!-- woofer -->
    <circle cx="0" cy="-30" r="74" fill="url(#cone)" stroke="hsl(${h}, 32%, 46%)" stroke-width="3"/>
    <circle cx="0" cy="-30" r="74" fill="none" stroke="#000" stroke-opacity=".5" stroke-width="10" transform="scale(.94)"/>
    <circle cx="0" cy="-30" r="46" fill="url(#dust)"/>
    <circle cx="0" cy="-30" r="20" fill="hsl(${h}, 20%, 16%)" stroke="hsl(${h}, 35%, 50%)" stroke-width="2"/>
    <circle cx="-8" cy="-38" r="5" fill="#fff" opacity=".5"/>
    <!-- tweeter -->
    <circle cx="0" cy="92" r="36" fill="url(#cone)" stroke="hsl(${h}, 32%, 46%)" stroke-width="2.5"/>
    <circle cx="0" cy="92" r="14" fill="hsl(${h}, 22%, 18%)" stroke="hsl(${h}, 35%, 52%)" stroke-width="1.5"/>
    <circle cx="-4" cy="88" r="3" fill="#fff" opacity=".45"/>
    <!-- logo chấm nhỏ -->
    <circle cx="0" cy="140" r="4" fill="hsl(${h}, 90%, 62%)"/>
  </g>

  <rect width="800" height="600" fill="url(#floor)"/>
  <text x="400" y="540" font-family="'Arial Black', Arial, sans-serif" font-size="38" font-weight="900" fill="hsl(${h}, 95%, 74%)" text-anchor="middle" letter-spacing="2">${label.toUpperCase()}</text>
</svg>`;
}

const BRANDS = [
  "JBL", "Yamaha", "Bose", "Marshall", "BMB", "Behringer",
  "QSC", "Shure", "EV", "Sony", "Yamaha", "BMB",
];

// 24 ảnh = 12 tin × 2 ảnh — nhãn theo tin (mỗi tin 2 ảnh liên tiếp)
for (let n = 1; n <= 24; n++) {
  const brand = BRANDS[Math.floor((n - 1) / 2)]!;
  const file = `public/img/listings/listing-${n}.svg`;
  writeFileSync(file, makeSvg(brand, (Math.floor((n - 1) / 2) * 47 + 205) % 360));
}
console.log("✓ 24 ảnh đã ghi đè với mesh gradient mới");
