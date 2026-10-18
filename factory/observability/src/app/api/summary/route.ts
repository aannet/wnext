import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { buildSummary } from "@/lib/summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildSummary(getStore()), { headers: { "Cache-Control": "no-store" } });
}
