const LOGIN_URL = "https://iclass.ucas.edu.cn:8181/app/user/login.action";
const SCHEDULE_URL = "https://iclass.ucas.edu.cn:8181/app/course/get_stu_course_sched.action";
const TIMESTAMP_URL = "https://iclass.ucas.edu.cn:8181/app/common/get_timestamp.do";
const SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

const LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";
const REQUEST_TIMEOUT_MS = 10000;
const SIGN_TIMESTAMP_BUFFER_MS = 3000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export type AutoSignCourse = {
	id?: string;
	uuid?: string;
	courseName?: string;
	teacherName?: string;
	weekDay?: string;
	classBeginTime?: string;
	classEndTime?: string;
	signStatus?: string;
};

type LoginResponse = {
	STATUS?: string;
	result?: {
		id?: string;
		sessionId?: string;
	};
};

type ScheduleResponse = {
	STATUS?: string;
	result?: AutoSignCourse[];
};

export type UpstreamSignResult = {
	status: string;
	message: string;
	stuSignId: string;
	stuSignStatus: string;
};

type UpstreamSignResponse = {
	STATUS?: string;
	message?: string;
	msg?: string;
	ERRMSG?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
		msg?: string;
	};
};

type TimestampResponse = {
	STATUS?: string;
	timestamp?: number;
};

export class UcasAutoSignError extends Error {}

async function fetchJson<T>(url: string, init: RequestInit): Promise<T> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(url, {
			...init,
			cache: "no-store",
			signal: controller.signal
		});

		if (!response.ok) {
			throw new UcasAutoSignError(`上游接口 HTTP ${response.status}`);
		}

		return (await response.json()) as T;
	} catch (error) {
		if (error instanceof UcasAutoSignError) {
			throw error;
		}
		if (error instanceof Error && error.name === "AbortError") {
			throw new UcasAutoSignError("上游接口请求超时");
		}
		throw new UcasAutoSignError("上游接口网络异常");
	} finally {
		clearTimeout(timeoutId);
	}
}

function buildLoginBody(username: string, password: string): string {
	const verificationUrlTemplate =
		"http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}";

	return new URLSearchParams({
		phone: username,
		password,
		verificationType: "1",
		verificationUrl: verificationUrlTemplate,
		userLevel: "1"
	}).toString();
}

export async function login(username: string, password: string): Promise<{ sessionId: string; userId: string }> {
	const data = await fetchJson<LoginResponse>(LOGIN_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": LOGIN_UA
		},
		body: buildLoginBody(username, password)
	});

	const sessionId = data.result?.sessionId ?? "";
	const userId = data.result?.id ?? "";
	if (data.STATUS !== "0" || !sessionId || !userId) {
		throw new UcasAutoSignError("登录失败，请检查 UCAS_USERNAME 和 UCAS_PASSWORD");
	}

	return { sessionId, userId };
}

export async function fetchSchedule(
	sessionId: string,
	userId: string,
	date: string
): Promise<AutoSignCourse[]> {
	const url = `${SCHEDULE_URL}?id=${encodeURIComponent(userId)}&dateStr=${encodeURIComponent(date)}`;
	const data = await fetchJson<ScheduleResponse>(url, {
		method: "GET",
		headers: {
			sessionId,
			"User-Agent": API_UA
		}
	});

	if (data.STATUS !== "0") {
		throw new UcasAutoSignError("课表查询失败");
	}

	return data.result ?? [];
}

async function getUpstreamTimestamp(): Promise<number> {
	try {
		const data = await fetchJson<TimestampResponse>(
			`${TIMESTAMP_URL}?id=${Math.floor(Math.random() * 1000000)}`,
			{
				method: "POST",
				headers: {
					"User-Agent": API_UA,
					Connection: "Keep-Alive"
				}
			}
		);
		if (data.STATUS === "0" && typeof data.timestamp === "number") {
			return data.timestamp - SIGN_TIMESTAMP_BUFFER_MS;
		}
	} catch {}

	return Date.now() - SIGN_TIMESTAMP_BUFFER_MS;
}

export async function signCourse(
	sessionId: string,
	userId: string,
	courseSchedId: string,
	timestamp: number
): Promise<UpstreamSignResult> {
	const url = `${SIGN_URL}?courseSchedId=${encodeURIComponent(courseSchedId)}&timestamp=${timestamp}&id=${encodeURIComponent(userId)}`;
	const data = await fetchJson<UpstreamSignResponse>(url, {
		method: "GET",
		headers: {
			sessionId,
			"User-Agent": API_UA
		}
	});

	const status = data.STATUS ?? "";
	const stuSignId = data.result?.stuSignId ?? "";
	const stuSignStatus = data.result?.stuSignStatus ?? "";
	const message = data.result?.msg ?? data.ERRMSG ?? data.msg ?? data.message ?? "";

	return { status, message, stuSignId, stuSignStatus };
}

function getBeijingDateParts(now: Date): { year: number; month: number; day: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(now);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

	return {
		year: Number(values.year),
		month: Number(values.month),
		day: Number(values.day)
	};
}

export function getBeijingDateString(now = new Date()): string {
	const { year, month, day } = getBeijingDateParts(now);
	return `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

function getClockSeconds(value: string | undefined): number | null {
	const match = value?.match(/(\d{2}):(\d{2})(?::(\d{2}))?$/);
	if (!match) {
		return null;
	}

	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	const seconds = Number(match[3] ?? "0");
	if (hours > 23 || minutes > 59 || seconds > 59) {
		return null;
	}
	return hours * 3600 + minutes * 60 + seconds;
}

function parseBeijingDateTime(date: string, value: string | undefined): number | null {
	const clockSeconds = getClockSeconds(value);
	if (clockSeconds === null || !/^\d{8}$/.test(date)) {
		return null;
	}

	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(4, 6));
	const day = Number(date.slice(6, 8));
	const utcMillis = Date.UTC(year, month - 1, day) + clockSeconds * 1000;
	return utcMillis - BEIJING_OFFSET_MS;
}

export function isCourseInSignWindow(course: AutoSignCourse, date: string, now = Date.now()): boolean {
	const classBegin = parseBeijingDateTime(date, course.classBeginTime);
	const classEnd = parseBeijingDateTime(date, course.classEndTime);
	if (classBegin === null || classEnd === null) {
		return false;
	}

	return now >= classBegin - 10 * 60 * 1000 && now <= classEnd;
}

export async function getSigningTimestamp(): Promise<number> {
	return getUpstreamTimestamp();
}
