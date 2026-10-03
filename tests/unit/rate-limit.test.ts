/**
 * Rate limiter — sliding window in-memory, single-process.
 * Yêu cầu: đúng window logic, retryAfter dương, key isolate nhau,
 * fail-open khi limiter lỗi nội bộ (availability), sweep an toàn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  checkRateLimit,
  clientIpFromHeaders,
  resetRateLimits,
  type RateLimitRule,
} from "../../src/lib/rate-limit";

const RULE: RateLimitRule = { limit: 3, windowMs: 60_000 };

beforeEach(() => {
  vi.useFakeTimers();
  resetRateLimits();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkRateLimit — sliding window", () => {
  it("cho phép N request đầu, từ chối request thứ N+1", () => {
    expect(checkRateLimit("auth:login:1.2.3.4", RULE)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
    expect(checkRateLimit("auth:login:1.2.3.4", RULE)).toMatchObject({
      allowed: true,
      remaining: 1,
    });
    expect(checkRateLimit("auth:login:1.2.3.4", RULE)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    const denied = checkRateLimit("auth:login:1.2.3.4", RULE);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("từ chối KHÔNG tiêu hit — retryAfter giảm dần theo thời gian", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("auth:login:ip", RULE);
    const first = checkRateLimit("auth:login:ip", RULE);
    expect(first.allowed).toBe(false);
    vi.advanceTimersByTime(30_000);
    const second = checkRateLimit("auth:login:ip", RULE);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterSec).toBeLessThan(first.retryAfterSec);
  });

  it("hết window → cho phép lại (hit cũ trượt ra)", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("auth:login:ip", RULE);
    expect(checkRateLimit("auth:login:ip", RULE).allowed).toBe(false);
    vi.advanceTimersByTime(61_000);
    expect(checkRateLimit("auth:login:ip", RULE).allowed).toBe(true);
  });

  it("các key độc lập — IP khác không bị ảnh hưởng", () => {
    for (let i = 0; i < 3; i++) checkRateLimit("auth:login:a", RULE);
    expect(checkRateLimit("auth:login:a", RULE).allowed).toBe(false);
    expect(checkRateLimit("auth:login:b", RULE).allowed).toBe(true);
    // scope khác cùng IP cũng độc lập
    for (let i = 0; i < 3; i++) checkRateLimit("auth:login:a", RULE);
    expect(checkRateLimit("upload:a", RULE).allowed).toBe(true);
  });
});

describe("clientIpFromHeaders — identity sau reverse proxy (TRUST_PROXY_HEADERS gate)", () => {
  it("mặc định KHÔNG tin proxy headers — header spoof bị bỏ qua (fail-safe)", () => {
    delete process.env.TRUST_PROXY_HEADERS;
    const spoofed = new Headers({
      "x-real-ip": "203.0.113.66",
      "x-forwarded-for": "203.0.113.66, 10.0.0.1",
    });
    expect(clientIpFromHeaders(spoofed)).toBe("local");
  });

  it("TRUST_PROXY_HEADERS != true (giá trị lạ) — vẫn không tin (fail-safe)", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "yes");
    const spoofed = new Headers({ "x-real-ip": "203.0.113.66" });
    expect(clientIpFromHeaders(spoofed)).toBe("local");
    vi.unstubAllEnvs();
  });

  it("TRUST_PROXY_HEADERS=true → ưu tiên x-real-ip (nginx đặt theo deployment doc)", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const h = new Headers({ "x-real-ip": "203.0.113.9" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.9");
    vi.unstubAllEnvs();
  });

  it("TRUST_PROXY_HEADERS=true → x-forwarded-for: lấy IP cuối cùng (proxy thêm), bỏ hop spoof được", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    const h = new Headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.10" });
    expect(clientIpFromHeaders(h)).toBe("203.0.113.10");
    vi.unstubAllEnvs();
  });

  it("TRUST_PROXY_HEADERS=true, không có proxy header → bucket 'local'", () => {
    vi.stubEnv("TRUST_PROXY_HEADERS", "true");
    expect(clientIpFromHeaders(new Headers())).toBe("local");
    vi.unstubAllEnvs();
  });
});
