import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
	return NextResponse.json(
		{
			version: process.env.VERCEL_GIT_COMMIT_SHA || "local-dev",
			message: process.env.VERCEL_GIT_COMMIT_MESSAGE || "页面代码已经更新，立即刷新体验最新功能",
		},
		{
			headers: {
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}
