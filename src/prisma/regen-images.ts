/**
 * Ảnh placeholder kiểu ảnh chụp sản phẩm thật — loa trên nền studio, bóng đổ mềm.
 * Chạy: npx tsx src/prisma/regen-images.ts
 */
import { writeFileSync } from "node:fs";

/** Vẽ loa thùng đứng — ảnh kiểu chụp studio */
function speakerSvg(brand: string, hue: number): string {
  const h = hue;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${h}, 10%, 88%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 12%, 78%)"/>
    </linearGradient>
    <radialGradient id="vign" cx="50%" cy="42%" r="75%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity=".14"/>
    </radialGradient>
    <linearGradient id="cab" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="hsl(${h}, 8%, 24%)"/>
      <stop offset="8%" stop-color="hsl(${h}, 9%, 31%)"/>
      <stop offset="50%" stop-color="hsl(${h}, 8%, 27%)"/>
      <stop offset="92%" stop-color="hsl(${h}, 10%, 20%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 8%, 15%)"/>
    </linearGradient>
    <radialGradient id="cone" cx="50%" cy="40%" r="65%">
      <stop offset="0%" stop-color="hsl(${h}, 6%, 42%)"/>
      <stop offset="70%" stop-color="hsl(${h}, 7%, 30%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 8%, 22%)"/>
    </radialGradient>
    <radialGradient id="dust" cx="50%" cy="38%" r="60%">
      <stop offset="0%" stop-color="hsl(${h}, 6%, 52%)" stop-opacity=".9"/>
      <stop offset="100%" stop-color="hsl(${h}, 7%, 30%)" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="tweeter" cx="50%" cy="35%" r="70%">
      <stop offset="0%" stop-color="hsl(${h}, 5%, 55%)"/>
      <stop offset="100%" stop-color="hsl(${h}, 6%, 28%)"/>
    </radialGradient>
    <linearGradient id="shadow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000" stop-opacity=".30"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- nền studio -->
  <rect width="800" height="600" fill="url(#bg)"/>
  <rect width="800" height="600" fill="url(#vign)"/>

  <!-- bóng đổ mềm dưới loa -->
  <ellipse cx="400" cy="512" rx="185" ry="30" fill="url(#shadow)" opacity=".8"/>

  <!-- thùng loa -->
  <g transform="translate(400, 300)">
    <!-- thân -->
    <rect x="-140" y="-190" width="280" height="400" rx="10" fill="url(#cab)"/>
    <!-- cạnh viền nhạt -->
    <rect x="-140" y="-190" width="280" height="400" rx="10" fill="none" stroke="hsl(${h}, 8%, 38%)" stroke-opacity=".5"/>
    <!-- highlight dọc trái -->
    <rect x="-134" y="-184" width="10" height="388" rx="5" fill="#fff" opacity=".08"/>

    <!-- màng loa bass -->
    <circle cx="0" cy="-55" r="88" fill="url(#cone)"/>
    <circle cx="0" cy="-55" r="88" fill="none" stroke="hsl(${h}, 8%, 45%)" stroke-width="3" stroke-opacity=".7"/>
    <!-- vành ngoài màng -->
    <circle cx="0" cy="-55" r="88" fill="none" stroke="#000" stroke-opacity=".35" stroke-width="7" transform="scale(.93)"/>
    <!-- chóp giữa -->
    <circle cx="0" cy="-55" r="52" fill="url(#dust)"/>
    <circle cx="0" cy="-55" r="20" fill="hsl(${h}, 8%, 18%)"/>
    <circle cx="0" cy="-55" r="20" fill="none" stroke="hsl(${h}, 8%, 48%)" stroke-width="1.6"/>
    <!-- phản chiếu ánh sáng -->
    <ellipse cx="-22" cy="-82" rx="14" ry="8" fill="#fff" opacity=".22" transform="rotate(-18 -22 -82)"/>

    <!-- loa treble -->
    <circle cx="0" cy="95" r="44" fill="url(#tweeter)"/>
    <circle cx="0" cy="95" r="44" fill="none" stroke="hsl(${h}, 8%, 42%)" stroke-width="2.4" stroke-opacity=".8"/>
    <circle cx="0" cy="95" r="15" fill="hsl(${h}, 7%, 20%)"/>
    <circle cx="0" cy="95" r="15" fill="none" stroke="hsl(${h}, 8%, 50%)" stroke-width="1.2"/>
    <ellipse cx="-6" cy="88" rx="5" ry="3" fill="#fff" opacity=".2"/>

    <!-- cổng thoát hơi -->
    <rect x="-26" y="158" width="52" height="7" rx="3.5" fill="#000" fill-opacity=".5"/>
    <rect x="-26" y="158" width="52" height="7" rx="3.5" fill="none" stroke="hsl(${h}, 8%, 40%)" stroke-opacity=".4"/>

    <!-- logo chấm nhỏ trên thân -->
    <circle cx="0" cy="-160" r="5" fill="hsl(${h}, 30%, 65%)" opacity=".85"/>
  </g>

  <!-- nhãn thương hiệu — kiểu watermark ảnh chụp -->
  <text x="400" y="560" font-family="Arial, sans-serif" font-size="26" font-weight="800" fill="hsl(${h}, 10%, 30%)" fill-opacity=".55" text-anchor="middle" letter-spacing="6">${brand.toUpperCase()}</text>
</svg>`;
}

const BRANDS = [
  "JBL", "Yamaha", "Bose", "Marshall", "BMB", "Behringer",
  "QSC", "Shure", "EV", "Sony", "Yamaha", "BMB",
];

// 24 ảnh = 12 tin × 2 ảnh — mỗi tin 2 góc chụp khác nhau
for (let n = 1; n <= 24; n++) {
  const brand = BRANDS[Math.floor((n - 1) / 2)]!;
  // ảnh chẵn: xoay nhẹ + zoom khác để như 2 góc chụp
  const variant = n % 2 === 0;
  let svg = speakerSvg(brand, (Math.floor((n - 1) / 2) * 37 + 20) % 360);
  if (variant) {
    // góc 2: nghiêng nhẹ 3 độ + dịch khung
    svg = svg.replace("<g transform=", '<g transform-origin="400 300" ');
    svg = svg.replace(
      'transform-origin="400 300" ',
      'transform-origin="400 300" transform="rotate(3 400 300) translate(14 -8)" ',
    );
  }
  writeFileSync(`public/img/listings/listing-${n}.svg`, svg);
}
console.log("✓ 24 ảnh sản phẩm kiểu studio đã ghi đè");
