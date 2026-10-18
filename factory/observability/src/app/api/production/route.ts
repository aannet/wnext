import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import { buildProduction } from "@/lib/production";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/production?phase=P1&line=P1-003 : agents en cours, matrice phase x agent, flux et appels. */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  return NextResponse.json(buildProduction(getStore(), { phase: p.get("phase"), line: p.get("line") }), {
    headers: { "Cache-Control": "no-store" },
  });
}
