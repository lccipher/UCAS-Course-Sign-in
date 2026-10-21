#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(projectRoot, "config", "ucas-account.json");
const baseUrl = getBaseUrl(process.argv.slice(2));
const SIGN_WINDOW_BEFORE_MS = 10 * 60 * 1000;
const SIGN_RETRY_DELAY_MS = 30 * 1000;
const SCHEDULE_RETRY_DELAY_MS = toPositiveInt(process.env.AUTO_SIGN_SCHEDULE_RETRY_DELAY_MS, 5 * 60 * 1000);
const SCHEDULE_MAX_ATTEMPTS = toPositiveInt(process.env.AUTO_SIGN_SCHEDULE_MAX_ATTEMPTS, 3);
const activeTimers = new Set();
const activeCourseKeys = new Set();
let scheduleTimer = null;

class ScheduleFetchError extends Error {
	constructor(message, { status = 0, retryAfterMs = 0 } = {}) {
		super(message);
		this.name = "ScheduleFetchError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

function toPositiveInt(value, fallback) {
	const parsed = Number.parseInt(value ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBaseUrl(args) {
	const index = args.indexOf("--base-url");
	const requested = index >= 0 ? args[index + 1] : "http://127.0.0.1:3000";
	return (requested || "http://127.0.0.1:3000").replace(/\/+$/, "");
}

async function readConfig() {
	const raw = await readFile(configPath, "utf8");
	const config = JSON.parse(raw);
	const username = typeof config?.username === "string" ? config.username.trim() : "";
	const password = typeof config?.password === "string" ? config.password : "";
	const cronSecret = typeof config?.cronSecret === "string" ? config.cronSecret.trim() : "";
	if (
		!username ||
		!password ||
		!cronSecret ||
		username.includes("填入") ||
		password.includes("填入") ||
		cronSecret.includes("填入")
	) {
		throw new Error(`请先填写 ${configPath} 中的 username、password 和 cronSecret`);
	}
	return { username, password, cronSecret };
}

function getBeijingDateString(now = new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit"
	}).formatToParts(now);
	const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
	return `${values.year}${values.month}${values.day}`;
}

function parseClockSeconds(value) {
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

function parseBeijingDateTime(date, value) {
	const clockSeconds = parseClockSeconds(value);
	if (clockSeconds === null || !/^\d{8}$/.test(date)) {
		return null;
	}

	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(4, 6));
	const day = Number(date.slice(6, 8));
	return Date.UTC(year, month - 1, day) + clockSeconds * 1000 - 8 * 60 * 60 * 1000;
}

function beijingEight(date) {
	const year = Number(date.slice(0, 4));
	const month = Number(date.slice(4, 6));
	const day = Number(date.slice(6, 8));
	return Date.UTC(year, month - 1, day, 8) - 8 * 60 * 60 * 1000;
}

function nextScheduleAt(now = Date.now()) {
	const date = getBeijingDateString(new Date(now));
	const todayEight = beijingEight(date);
	if (todayEight > now) {
		return todayEight;
	}

	const tomorrow = getBeijingDateString(new Date(now + 24 * 60 * 60 * 1000));
	return beijingEight(tomorrow);
}

function setTimer(callback, delayMs) {
	const timer = setTimeout(() => {
		activeTimers.delete(timer);
		void callback();
	}, Math.max(0, delayMs));
	activeTimers.add(timer);
	return timer;
}

function setScheduleTimer(callback, delayMs) {
	if (scheduleTimer) {
		clearTimeout(scheduleTimer);
		activeTimers.delete(scheduleTimer);
	}
	scheduleTimer = setTimer(async () => {
		scheduleTimer = null;
		await callback();
	}, delayMs);
}

function clearTimers() {
	for (const timer of activeTimers) {
		clearTimeout(timer);
	}
	activeTimers.clear();
	scheduleTimer = null;
}

async function fetchTodaySchedule(config, date) {
	const response = await fetch(`${baseUrl}/api/course-uuid/query`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ username: config.username, password: config.password, date }),
		cache: "no-store"
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		const retryAfterSeconds = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
		throw new ScheduleFetchError(data.message ?? `课表查询失败（HTTP ${response.status}）`, {
			status: response.status,
			retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1000 : 0
		});
	}
	return data;
}

function getCourseKey(course) {
	return [course.courseName, course.classBeginTime, course.classEndTime].join("|");
}

async function triggerCourse(config, course, courseKey, attempt = 1) {
	const courseIds = course.courseIds?.length ? course.courseIds : [course.id];
	const courseId = courseIds[(attempt - 1) % courseIds.length];
	try {
		const response = await fetch(
			`${baseUrl}/api/course-uuid/cron-sign?courseId=${encodeURIComponent(courseId)}`,
			{
			headers: {
				Authorization: `Bearer ${config.cronSecret}`
			},
			cache: "no-store"
			}
		);
		const data = await response.json();
		console.log(
			`[${new Date().toISOString()}] ${course.courseName || courseId} (${courseId}) sign attempt ${attempt}: ${response.status} ${data.message ?? ""}`
		);

		if (data.success) {
			activeCourseKeys.delete(courseKey);
			return;
		}
		setTimer(() => triggerCourse(config, course, courseKey, attempt + 1), SIGN_RETRY_DELAY_MS);
	} catch (error) {
		console.error(
			`[${new Date().toISOString()}] ${course.courseName || courseId} (${courseId}) sign request failed: ${error.message}`
		);
		setTimer(() => triggerCourse(config, course, courseKey, attempt + 1), SIGN_RETRY_DELAY_MS);
	}
}

function scheduleNextDay(config) {
	const nextRefreshDelay = Math.max(1000, nextScheduleAt() - Date.now());
	setScheduleTimer(() => scheduleToday(config), nextRefreshDelay);
}

async function scheduleToday(config, attempt = 1) {
	const date = getBeijingDateString();

	try {
		const data = await fetchTodaySchedule(config, date);
		if (data.noCourses === true || data.total === 0) {
			console.log(`[${new Date().toISOString()}] ${date}: no courses, no schedule retry`);
			scheduleNextDay(config);
			return;
		}

		const now = Date.now();
		let scheduled = 0;
		const courseGroups = new Map();

		for (const course of data.courses ?? []) {
			const courseKey = getCourseKey(course);
			if (course.signStatus === "1" || !/^\d{7}$/.test(course.id ?? "")) {
				continue;
			}
			const group = courseGroups.get(courseKey);
			if (group) {
				group.courseIds.push(course.id);
			} else {
				courseGroups.set(courseKey, { ...course, courseIds: [course.id] });
			}
		}

		for (const course of courseGroups.values()) {
			const courseKey = getCourseKey(course);
			if (activeCourseKeys.has(courseKey)) {
				continue;
			}

			const classBegin = parseBeijingDateTime(date, course.classBeginTime);
			const classEnd = parseBeijingDateTime(date, course.classEndTime);
			if (classBegin === null || classEnd === null) {
				continue;
			}

			const runAt = Math.max(now, classBegin - SIGN_WINDOW_BEFORE_MS);
			if (runAt > classEnd) {
				continue;
			}

			activeCourseKeys.add(courseKey);
			setTimer(() => triggerCourse(config, course, courseKey), runAt - now);
			scheduled += 1;
			console.log(
				`scheduled ${course.courseName || course.id} (${course.courseIds.join(",")}) at ${new Date(runAt).toLocaleString("zh-CN", {
					timeZone: "Asia/Shanghai"
				})}`
			);
		}

		console.log(`[${new Date().toISOString()}] ${date}: checked ${data.total ?? 0}, scheduled ${scheduled}`);
	} catch (error) {
		const retryAfterMs = error instanceof ScheduleFetchError ? error.retryAfterMs : 0;
		const retryDelayMs = Math.max(SCHEDULE_RETRY_DELAY_MS, retryAfterMs);
		if (attempt < SCHEDULE_MAX_ATTEMPTS) {
			console.error(
				`[${new Date().toISOString()}] schedule fetch failed (attempt ${attempt}/${SCHEDULE_MAX_ATTEMPTS}, ` +
					`status ${error.status ?? "unknown"}): ${error.message}; retrying in ${Math.ceil(retryDelayMs / 1000)}s`
			);
			setScheduleTimer(() => scheduleToday(config, attempt + 1), retryDelayMs);
			return;
		}

		console.error(
			`[${new Date().toISOString()}] schedule fetch failed after ${SCHEDULE_MAX_ATTEMPTS} attempts; ` +
			`skip today: ${error.message}`
		);
		scheduleNextDay(config);
		return;
	}

	const nextRefreshDelay = nextScheduleAt() - Date.now();
	setScheduleTimer(() => scheduleToday(config), nextRefreshDelay);
}

try {
	const config = await readConfig();

	console.log(
		`Local auto-sign scheduler started for ${baseUrl}; schedule query attempts limited to ${SCHEDULE_MAX_ATTEMPTS}`
	);
	const todayEight = beijingEight(getBeijingDateString());
	if (Date.now() < todayEight) {
		console.log(`today's schedule will be fetched at ${new Date(todayEight).toLocaleString("zh-CN", {
			timeZone: "Asia/Shanghai"
		})}`);
		setScheduleTimer(() => scheduleToday(config), todayEight - Date.now());
	} else {
		await scheduleToday(config);
	}

	const stop = () => {
		clearTimers();
		console.log("Local auto-sign scheduler stopped");
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
} catch (error) {
	console.error(`Unable to start local auto-sign scheduler: ${error.message}`);
	process.exit(1);
}
