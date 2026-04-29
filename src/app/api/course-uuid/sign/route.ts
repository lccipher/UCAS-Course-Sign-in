import { NextRequest, NextResponse } from "next/server";

const LOGIN_URL = "https://iclass.ucas.edu.cn:8181/app/user/login.action";
const SIGN_URL = "http://124.16.75.106:8081/app/course/stu_scan_sign.action";

const LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";

const RESPONSE_HEADERS = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
};
const REQUEST_TIMEOUT_MS = 10000;

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_WINDOW_MAX = toPositiveInt(process.env.RATE_LIMIT_5M_MAX, 5);
const RATE_LIMIT_DAILY_MAX = toPositiveInt(process.env.RATE_LIMIT_DAILY_MAX, 20);
const RATE_LIMIT_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const MAX_USERNAME_LENGTH = 40;
const MAX_PASSWORD_LENGTH = 80;

type RateLimitState = {
	windowHits: number[];
	dailyCount: number;
	dailyResetAt: number;
};

type LoginResponse = {
	STATUS?: string;
	result?: {
		id?: string;
		sessionId?: string;
	};
};

type UpstreamSignResponse = {
	STATUS?: string;
	message?: string;
	msg?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
		msg?: string;
	};
};

const ipRateLimitStore = new Map<string, RateLimitState>();
let lastRateLimitSweepAt = 0;

class ApiError extends Error {
	status: number;
	code: string;
	stage: "login" | "sign" | "request";

	constructor(status: number, code: string, message: string, stage: "login" | "sign" | "request") {
		super(message);
		this.status = status;
		this.code = code;
		this.stage = stage;
	}
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonWithHeaders(body: unknown, init: { status: number; headers?: Record<string, string> }) {
	return NextResponse.json(body, {
		status: init.status,
		headers: {
			...RESPONSE_HEADERS,
			...(init.headers ?? {}),
		},
	});
}

function toPositiveInt(value: string | undefined, fallback: number): number {
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(req: NextRequest): string {
	const xff = req.headers.get("x-forwarded-for");
	if (xff) {
		return xff.split(",")[0]?.trim() || "unknown";
	}
	return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function isSameOriginRequest(req: NextRequest): boolean {
	const origin = req.headers.get("origin");
	if (!origin) {
		return true;
	}

	const host = req.headers.get("host");
	if (!host) {
		return false;
	}

	try {
		const originHost = new URL(origin).host;
		return originHost === host;
	} catch {
		return false;
	}
}

function sweepRateLimitStore(now: number) {
	if (now - lastRateLimitSweepAt < RATE_LIMIT_SWEEP_INTERVAL_MS) {
		return;
	}

	for (const [ip, state] of ipRateLimitStore.entries()) {
		state.windowHits = state.windowHits.filter((ts) => now - ts <= FIVE_MINUTES_MS);

		if (state.dailyResetAt <= now) {
			state.dailyCount = 0;
			state.dailyResetAt = now + ONE_DAY_MS;
		}

		if (state.windowHits.length === 0 && state.dailyCount === 0) {
			ipRateLimitStore.delete(ip);
		}
	}

	lastRateLimitSweepAt = now;
}

function consumeRateLimit(ip: string, now: number): { ok: true } | { ok: false; retryAfterSec: number } {
	sweepRateLimitStore(now);

	const state =
		ipRateLimitStore.get(ip) ??
		({
			windowHits: [],
			dailyCount: 0,
			dailyResetAt: now + ONE_DAY_MS,
		} satisfies RateLimitState);

	if (state.dailyResetAt <= now) {
		state.dailyCount = 0;
		state.dailyResetAt = now + ONE_DAY_MS;
	}

	state.windowHits = state.windowHits.filter((ts) => now - ts <= FIVE_MINUTES_MS);

	if (state.windowHits.length >= RATE_LIMIT_WINDOW_MAX) {
		const oldestAllowed = state.windowHits[0] + FIVE_MINUTES_MS;
		const retryAfterSec = Math.max(1, Math.ceil((oldestAllowed - now) / 1000));
		ipRateLimitStore.set(ip, state);
		return { ok: false, retryAfterSec };
	}

	if (state.dailyCount >= RATE_LIMIT_DAILY_MAX) {
		const retryAfterSec = Math.max(1, Math.ceil((state.dailyResetAt - now) / 1000));
		ipRateLimitStore.set(ip, state);
		return { ok: false, retryAfterSec };
	}

	state.windowHits.push(now);
	state.dailyCount += 1;
	ipRateLimitStore.set(ip, state);

	return { ok: true };
}

function isCredentialInputInvalid(username: string, password: string): boolean {
	if (!username || !password) {
		return true;
	}
	if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
		return true;
	}
	if (/\s/.test(username)) {
		return true;
	}
	return false;
}

function normalizeCourseSchedId(raw: string): string | null {
	const compact = raw.trim().replace(/-/g, "");
	if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
		return null;
	}
	return compact.toUpperCase();
}

function buildLoginBody(username: string, password: string): string {
	const verificationUrlTemplate =
		"http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}";

	const body = new URLSearchParams({
		phone: username,
		password,
		verificationType: "1",
		verificationUrl: verificationUrlTemplate,
		userLevel: "1",
	});

	return body.toString();
}

export async function POST(req: NextRequest) {
	const startedAt = Date.now();
	const requestId = crypto.randomUUID();
	let stage: "login" | "sign" | "request" = "request";

	try {
		if (!isSameOriginRequest(req)) {
			return jsonWithHeaders({ message: "非法来源请求" }, { status: 403 });
		}

		const contentType = req.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return jsonWithHeaders({ message: "请求格式错误，请使用 application/json" }, { status: 415 });
		}

		const ip = getClientIp(req);
		const rateLimitResult = consumeRateLimit(ip, Date.now());
		if (!rateLimitResult.ok) {
			return jsonWithHeaders(
				{ message: "请求过于频繁，请稍后再试", code: "RATE_LIMITED" },
				{
					status: 429,
					headers: {
						"Retry-After": String(rateLimitResult.retryAfterSec),
					},
				},
			);
		}

		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return jsonWithHeaders({ message: "请求体 JSON 格式错误" }, { status: 400 });
		}

		const bodyObject = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
		const username = String(bodyObject.username ?? "").trim();
		const password = String(bodyObject.password ?? "");
		const courseSchedIdRaw = String(bodyObject.courseSchedId ?? bodyObject.timeTableId ?? "");
		const courseSchedId = normalizeCourseSchedId(courseSchedIdRaw);

		if (isCredentialInputInvalid(username, password)) {
			return jsonWithHeaders({ message: "学号或密码格式错误" }, { status: 400 });
		}

		if (!courseSchedId) {
			return jsonWithHeaders({ message: "课程 ID 格式错误" }, { status: 400 });
		}

		stage = "login";
		const loginAbortController = new AbortController();
		const loginTimeout = setTimeout(() => loginAbortController.abort(), REQUEST_TIMEOUT_MS);

		let loginData: LoginResponse;
		try {
			const loginRes = await fetch(LOGIN_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"User-Agent": LOGIN_UA,
				},
				body: buildLoginBody(username, password),
				cache: "no-store",
				signal: loginAbortController.signal,
			});

			if (!loginRes.ok) {
				throw new ApiError(502, "UPSTREAM_LOGIN_HTTP", `登录接口HTTP异常: ${loginRes.status}`, "login");
			}

			try {
				loginData = (await loginRes.json()) as LoginResponse;
			} catch {
				throw new ApiError(502, "UPSTREAM_LOGIN_BAD_JSON", "登录接口返回非JSON", "login");
			}
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			if (error instanceof Error && error.name === "AbortError") {
				throw new ApiError(504, "UPSTREAM_LOGIN_TIMEOUT", "登录接口请求超时", "login");
			}
			throw new ApiError(502, "UPSTREAM_LOGIN_NETWORK", "登录接口网络异常", "login");
		} finally {
			clearTimeout(loginTimeout);
		}

		const sessionId = loginData?.result?.sessionId;
		const userId = loginData?.result?.id;

		if (loginData?.STATUS !== "0" || !sessionId || !userId) {
			return jsonWithHeaders({ message: "登录失败，请检查学号密码是否正确" }, { status: 401 });
		}

		stage = "sign";
		const signAbortController = new AbortController();
		const signTimeout = setTimeout(() => signAbortController.abort(), REQUEST_TIMEOUT_MS);

		let signData: UpstreamSignResponse;
		try {
			const timestamp = Date.now();
			const upstreamUrl = `${SIGN_URL}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}&id=${encodeURIComponent(userId)}`;

			const signRes = await fetch(upstreamUrl, {
				method: "GET",
				headers: {
					sessionId,
					"User-Agent": API_UA,
				},
				cache: "no-store",
				signal: signAbortController.signal,
			});

			if (!signRes.ok) {
				throw new ApiError(502, "UPSTREAM_SIGN_HTTP", `签到接口HTTP异常: ${signRes.status}`, "sign");
			}

			try {
				signData = (await signRes.json()) as UpstreamSignResponse;
			} catch {
				throw new ApiError(502, "UPSTREAM_SIGN_BAD_JSON", "签到接口返回非JSON", "sign");
			}
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			if (error instanceof Error && error.name === "AbortError") {
				throw new ApiError(504, "UPSTREAM_SIGN_TIMEOUT", "签到接口请求超时", "sign");
			}
			throw new ApiError(502, "UPSTREAM_SIGN_NETWORK", "签到接口网络异常", "sign");
		} finally {
			clearTimeout(signTimeout);
		}

		const upstreamStatus = signData?.STATUS ?? "";
		const stuSignId = signData?.result?.stuSignId ?? "";
		const stuSignStatus = signData?.result?.stuSignStatus ?? "";
		const upstreamMessage = signData?.result?.msg ?? signData?.msg ?? signData?.message ?? "";

		if (upstreamStatus === "0" && stuSignStatus === "1") {
			return jsonWithHeaders(
				{
					success: true,
					message: "签到成功",
					upstreamStatus,
					result: {
						stuSignId,
						stuSignStatus,
					},
				},
				{ status: 200 },
			);
		}

		if (upstreamStatus === "0" && stuSignStatus && stuSignStatus !== "1") {
			return jsonWithHeaders(
				{
					success: false,
					message: "签到请求已提交，但状态未完成",
					upstreamStatus,
					result: {
						stuSignId,
						stuSignStatus,
					},
				},
				{ status: 409 },
			);
		}

		return jsonWithHeaders(
			{
				success: false,
				message: upstreamMessage || "签到失败，请稍后重试",
				upstreamStatus,
				result: {
					stuSignId,
					stuSignStatus,
				},
			},
			{ status: 400 },
		);
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		const isApiError = error instanceof ApiError;
		const logPayload = {
			requestId,
			stage,
			durationMs,
			errorName: error instanceof Error ? error.name : "UnknownError",
			errorMessage: error instanceof Error ? error.message : "Unknown error",
			code: isApiError ? error.code : "UNEXPECTED_ERROR",
		};

		console.error("[course-uuid/sign]", JSON.stringify(logPayload));

		if (isApiError) {
			return jsonWithHeaders({ message: error.message, code: error.code }, { status: error.status });
		}

		return jsonWithHeaders({ message: "服务暂时不可用，请稍后重试", code: "UNEXPECTED_ERROR" }, { status: 500 });
	}
}
