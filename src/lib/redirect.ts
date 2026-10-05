/**
 * Chống open redirect cho tham số ?next= (sau login/register).
 *
 * Lỗi đã chứng minh (WHATWG URL parser — cùng parser browser dùng cho
 * Location header): "/\\evil.com" được normalize thành "//evil.com" →
 * cross-origin. Check cũ `startsWith("/") && !startsWith("//")` cho qua.
 * Chứng minh: new URL("/\\evil.com", "http://local").href === "http://evil.com/"
 *
 * Quy tắc: chỉ chấp nhận path thuần cùng origin — bắt đầu "/", không "//",
 * không "/\", không control chars, và parse qua URL để chặn mọi scheme/host
 * lọt qua (vd "/\t" → "http://t/").
 */

/** Trả về path an toàn (pathname+search+hash) hoặc null nếu từ chối. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/")) return null; // chặn scheme tuyệt đối (https://…)
  if (next.startsWith("//")) return null; // protocol-relative
  if (next.startsWith("/\\")) return null; // browser normalize "\" như "/"
  // control chars (tab/newline) bị URL parser bỏ qua → "/\tevil" thành host
  if (/[\u0000-\u001f\u007f]/.test(next)) return null;
  try {
    const url = new URL(next, "http://redirect.invalid");
    if (url.origin !== "http://redirect.invalid") return null; // host lọt qua
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}
