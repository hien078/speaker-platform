import { destroySession } from "@/src/lib/auth";

export async function POST() {
  await destroySession();
  return Response.json({ ok: true });
}
