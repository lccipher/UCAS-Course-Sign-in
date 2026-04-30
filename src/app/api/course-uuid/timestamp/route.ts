import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMESTAMP_URL = "https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
};

const REQUEST_TIMEOUT_MS = 6000;

export async function GET() {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		// 添加随机 id 参数以防止中间节点缓存
		const url = `${TIMESTAMP_URL}?id=${Math.floor(Math.random() * 1000000)}`;

		const res = await fetch(url, {
			method: "POST",
			headers: {
				"User-Agent": API_UA,
				Connection: "Keep-Alive",
			},
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		const data = await res.json();
		if (data.STATUS === "0" && typeof data.timestamp === "number") {
			return NextResponse.json({ success: true, timestamp: data.timestamp }, { headers: RESPONSE_HEADERS });
		}
		return NextResponse.json(
			{ success: false, message: "Invalid server response" },
			{ status: 502, headers: RESPONSE_HEADERS },
		);
	} catch (e) {
		return NextResponse.json(
			{ success: false, message: "Failed to fetch server timestamp" },
			{ status: 504, headers: RESPONSE_HEADERS },
		);
	}
}
