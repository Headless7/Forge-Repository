import { NextResponse } from "next/server";
import { rawSql } from "@/server/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await rawSql()`select 1`;
    return NextResponse.json({ ok: true, database: "up" });
  } catch {
    return NextResponse.json({ ok: false, database: "down" }, { status: 503 });
  }
}
