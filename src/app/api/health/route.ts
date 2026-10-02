import { NextResponse } from "next/server";
import { rawSql } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    // A reachable but unmigrated database is not healthy: the deploy must not go live.
    const [{ migrated }] = await rawSql()`select to_regclass('public.users') is not null as migrated`;
    if (!migrated) return NextResponse.json({ ok: false, database: "not migrated" }, { status: 503 });
    return NextResponse.json({ ok: true, database: "up" });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
