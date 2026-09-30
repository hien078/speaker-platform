"use client";

import { useEffect } from "react";

/** Đăng ký service worker cho PWA (chỉ production build) */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .catch((err) => console.warn("SW register failed:", err));
  }, []);

  return null;
}
