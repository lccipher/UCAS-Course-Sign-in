import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	return NextResponse.json(
		{
			version: process.env.VERCEL_GIT_COMMIT_SHA || "v4",
		},
		{
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
