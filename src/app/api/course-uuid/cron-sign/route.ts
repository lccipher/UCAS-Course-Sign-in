import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
	fetchSchedule,
	getBeijingDateString,
	getSigningTimestamp,
	isCourseInSignWindow,
	login,
	signCourse,
	UcasAutoSignError
} from "@/lib/ucas-auto-sign";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY"
};
const LOCAL_CONFIG_PATH = join(process.cwd(), "config", "ucas-account.json");

type LocalAccountConfig = {
	username?: unknown;
	password?: unknown;
	cronSecret?: unknown;
};

class LocalConfigError extends Error {}

function json(body: unknown, status = 200) {
	return NextResponse.json(body, { status, headers: RESPONSE_HEADERS });
}

async function readLocalConfig(): Promise<{ username: string; password: string; cronSecret: string }> {
	let raw: string;
	try {
		raw = await readFile(LOCAL_CONFIG_PATH, "utf8");
	} catch {
		throw new LocalConfigError(`找不到本地配置文件：${LOCAL_CONFIG_PATH}`);
	}

	let parsed: LocalAccountConfig;
	try {
		parsed = JSON.parse(raw) as LocalAccountConfig;
	} catch {
		throw new LocalConfigError("本地配置文件不是合法 JSON");
	}

	const username = typeof parsed.username === "string" ? parsed.username.trim() : "";
	const password = typeof parsed.password === "string" ? parsed.password : "";
	const cronSecret = typeof parsed.cronSecret === "string" ? parsed.cronSecret.trim() : "";
	if (!username || !password || !cronSecret || username.includes("填入") || password.includes("填入")) {
		throw new LocalConfigError("本地配置文件缺少 username、password 或 cronSecret");
	}

	return { username, password, cronSecret };
}

function secretsMatch(provided: string, expected: string): boolean {
	const providedBytes = Buffer.from(provided);
	const expectedBytes = Buffer.from(expected);
	return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}

function isAuthorized(request: NextRequest, expected: string): boolean {
	const authorization = request.headers.get("authorization") ?? "";
	const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
	const provided = bearer || request.headers.get("x-cron-secret")?.trim() || "";
	return Boolean(provided) && secretsMatch(provided, expected);
}

export async function GET(request: NextRequest) {
	let config: { username: string; password: string; cronSecret: string };
	try {
		config = await readLocalConfig();
	} catch (error) {
		const message = error instanceof LocalConfigError ? error.message : "本地配置读取失败";
		return json({ message, code: "LOCAL_CONFIG_ERROR" }, 503);
	}

	if (!isAuthorized(request, config.cronSecret)) {
		return json({ message: "未授权的自动签到请求" }, 401);
	}

	const date = getBeijingDateString();
	const requestedCourseId = new URL(request.url).searchParams.get("courseId")?.trim() ?? "";
	if (requestedCourseId && !/^\d{7}$/.test(requestedCourseId)) {
		return json({ message: "课程 ID 格式错误", code: "INVALID_COURSE_ID" }, 400);
	}

	try {
		const { sessionId, userId } = await login(config.username, config.password);
		if (requestedCourseId) {
			const timestamp = await getSigningTimestamp();
			const result = await signCourse(sessionId, userId, requestedCourseId, timestamp);
			let success = result.status === "0" && result.stuSignStatus === "1";
			if (!success) {
				const courses = await fetchSchedule(sessionId, userId, date);
				success = courses.some((course) => course.id === requestedCourseId && course.signStatus === "1");
			}
			return json(
				{
					success,
					date,
					courseId: requestedCourseId,
					message: success ? "签到成功" : result.message || "签到尚未成功",
					result: {
						stuSignId: result.stuSignId,
						stuSignStatus: result.stuSignStatus
					}
				},
				success ? 200 : 409
			);
		}

		const courses = await fetchSchedule(sessionId, userId, date);
		const candidates = courses.filter(
			(course) =>
				course.signStatus !== "1" &&
				/^\d{7}$/.test(course.id ?? "") &&
				isCourseInSignWindow(course, date)
		);

		if (candidates.length === 0) {
			return json({ success: true, date, checked: courses.length, signed: [], skipped: "no-candidates" });
		}

		const timestamp = await getSigningTimestamp();
		const signed: Array<{ courseId: string; courseName: string; success: boolean; message: string }> = [];

		for (const course of candidates) {
			const courseId = course.id as string;
			const result = await signCourse(sessionId, userId, courseId, timestamp);
			signed.push({
				courseId,
				courseName: course.courseName ?? "",
				success: result.status === "0" && result.stuSignStatus === "1",
				message: result.message
			});
		}

		console.info(
			"[course-uuid/cron-sign]",
			JSON.stringify({ date, checked: courses.length, candidates: candidates.length, signed })
		);

		return json({ success: true, date, checked: courses.length, signed });
	} catch (error) {
		const message = error instanceof UcasAutoSignError ? error.message : "自动签到服务异常";
		console.error("[course-uuid/cron-sign]", message);
		return json({ success: false, date, message, code: "AUTO_SIGN_UPSTREAM_ERROR" }, 502);
	}
}
