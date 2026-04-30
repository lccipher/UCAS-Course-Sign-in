"use client";

import Image from "next/image";
import { FormEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

type CourseItem = {
	id: string;
	uuid: string;
	courseName: string;
	teacherName: string;
	weekDay: string;
	classBeginTime: string;
	classEndTime: string;
	signStatus: string;
};

type QueryResponse = {
	date: string;
	total: number;
	courses: CourseItem[];
};

type DirectSignResponse = {
	success?: boolean;
	message?: string;
	upstreamStatus?: string;
	result?: {
		stuSignId?: string;
		stuSignStatus?: string;
	};
};

type ThemeMode = "system" | "light" | "dark";
type StatusKind = "idle" | "loading" | "success" | "error" | "info";
type FeatureMode = "query" | "manual";

type RepoStarsCache = {
	stars: number;
	updatedAt: number;
};

const REPO_STARS_CACHE_KEY = "ucas-repo-stars-cache-v1";
const REPO_STARS_CACHE_TTL_MS = 1000 * 60 * 30;
const AUTO_QR_TTL_MS = 5 * 1000;
const DOWNLOAD_QR_TTL_MS = 10 * 1000;

const ACTION_STATUS_DEFAULT_TEXT = "生成签到码后，可在此查看下载、复制和点击签到的状态信息";
const SIGN_BASE_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";

type QrSource =
	| {
			mode: "query";
			uuid: string;
			courseId: string;
	  }
	| {
			mode: "manual";
			identifier: string;
	  };

function getSavedThemeMode(): ThemeMode {
	if (typeof window === "undefined") {
		return "system";
	}
	const saved = window.localStorage.getItem("ucas-theme-mode");
	return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
}

function toYyyyMMdd(dateInput: string): string {
	return dateInput.replace(/-/g, "");
}

function getTodayInputDate(): string {
	const now = new Date();
	const offset = now.getTimezoneOffset() * 60000;
	return new Date(now.getTime() - offset).toISOString().slice(0, 10);
}

function formatRange(start: string, end: string): string {
	const toTimeOnly = (value: string): string => {
		if (!value) {
			return "--";
		}

		const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
		if (timeMatch) {
			return timeMatch[1];
		}

		return value;
	};

	if (!start && !end) {
		return "--";
	}
	return `${toTimeOnly(start)} ~ ${toTimeOnly(end)}`;
}

function buildSignInUrl(courseId: string, expiresAt: number): string {
	return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(courseId)}&timestamp=${expiresAt}`;
}

function buildManualSignInUrl(identifier: string, expiresAt: number): string | null {
	const raw = identifier.trim();
	if (!raw) {
		return null;
	}

	if (/^\d+$/.test(raw)) {
		return `${SIGN_BASE_URL}?courseSchedId=${encodeURIComponent(raw)}&timestamp=${expiresAt}`;
	}

	const compact = raw.replace(/-/g, "");
	if (/^[0-9a-fA-F]{32}$/.test(compact)) {
		return `${SIGN_BASE_URL}?timeTableId=${encodeURIComponent(compact.toUpperCase())}&timestamp=${expiresAt}`;
	}

	return null;
}

function getSignIdentifierForFilename(signUrl: string, selectedUuid: string): string {
	if (!signUrl) {
		return selectedUuid || "unknown";
	}

	try {
		const url = new URL(signUrl);
		const courseSchedId = url.searchParams.get("courseSchedId");
		if (courseSchedId) {
			return courseSchedId;
		}

		const timeTableId = url.searchParams.get("timeTableId");
		if (timeTableId) {
			return timeTableId;
		}

		return selectedUuid || "unknown";
	} catch {
		return selectedUuid || "unknown";
	}
}

function extractClockTime(value: string): string | null {
	if (!value) {
		return null;
	}
	const timeMatch = value.match(/(\d{2}:\d{2}(?::\d{2})?)$/);
	if (!timeMatch) {
		return null;
	}
	return timeMatch[1].length === 5 ? `${timeMatch[1]}:00` : timeMatch[1];
}

function buildDateTimeFromClock(dateInput: string, clockTime: string | null): Date | null {
	if (!clockTime) {
		return null;
	}

	const parsed = new Date(`${dateInput}T${clockTime}`);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}
	return parsed;
}

function readRepoStarsCache(): RepoStarsCache | null {
	if (typeof window === "undefined") {
		return null;
	}

	try {
		const raw = window.localStorage.getItem(REPO_STARS_CACHE_KEY);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as RepoStarsCache;
		if (typeof parsed?.stars !== "number" || typeof parsed?.updatedAt !== "number") {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function writeRepoStarsCache(stars: number): void {
	if (typeof window === "undefined") {
		return;
	}

	try {
		const payload: RepoStarsCache = { stars, updatedAt: Date.now() };
		window.localStorage.setItem(REPO_STARS_CACHE_KEY, JSON.stringify(payload));
	} catch {}
}

export default function Home() {
	const repoUrl = "https://github.com/lccipher/UCAS-Course-Sign-in";
	const [themeMode, setThemeMode] = useState<ThemeMode>(getSavedThemeMode);
	const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
	const [repoStars, setRepoStars] = useState<number | null>(null);
	const [featureMode, setFeatureMode] = useState<FeatureMode>("query");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [manualIdentifier, setManualIdentifier] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [selectedUuid, setSelectedUuid] = useState("");
	const [statusText, setStatusText] = useState("输入学号、密码和日期，开始查询课程");
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [actionStatusText, setActionStatusText] = useState(ACTION_STATUS_DEFAULT_TEXT);
	const [actionStatusKind, setActionStatusKind] = useState<StatusKind>("idle");
	const [loading, setLoading] = useState(false);
	const [manualLoading, setManualLoading] = useState(false);
	const [directSignLoading, setDirectSignLoading] = useState(false);
	const [signUrl, setSignUrl] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [expireAt, setExpireAt] = useState(0);
	const [expireCountdown, setExpireCountdown] = useState(0);
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const [qrSource, setQrSource] = useState<QrSource | null>(null);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		setStatusText(message);
	};

	const updateActionStatus = (kind: StatusKind, message: string) => {
		setActionStatusKind(kind);
		setActionStatusText(message);
	};

	const timeOffsetRef = useRef<number | null>(null);

	const getServerTimeOffset = async (): Promise<number> => {
		if (timeOffsetRef.current !== null) {
			return timeOffsetRef.current;
		}

		try {
			const start = Date.now();
			const res = await fetch("/api/course-uuid/timestamp", {
				cache: "no-store",
			});
			if (!res.ok) {
				throw new Error();
			}
			const data = await res.json();
			if (data.success && typeof data.timestamp === "number") {
				const latency = Math.max(0, Date.now() - start);
				const serverTime = data.timestamp + Math.floor(latency / 2);
				const offset = serverTime - Date.now();
				timeOffsetRef.current = offset;
				return offset;
			}
		} catch {}

		timeOffsetRef.current = 0;
		return 0;
	};

	useEffect(() => {
		void getServerTimeOffset();
	}, []);

	const resetGeneratedSignState = () => {
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrRelayActive(false);
		setQrSource(null);
		setActionStatusKind("idle");
		setActionStatusText(ACTION_STATUS_DEFAULT_TEXT);
	};

	const getPayloadFromSource = (source: QrSource, deadline: number): string | null => {
		if (source.mode === "query") {
			return buildSignInUrl(source.courseId, deadline);
		}
		return buildManualSignInUrl(source.identifier, deadline);
	};

	const generateQrDataUrlFromPayload = async (payload: string): Promise<string> => {
		const { default: QRCode } = await import("qrcode");
		return QRCode.toDataURL(payload, {
			width: 320,
			margin: 1,
			errorCorrectionLevel: "M",
		});
	};

	const regenerateAutoQr = async (source: QrSource): Promise<boolean> => {
		const offset = await getServerTimeOffset();
		const currentTimestamp = Date.now() + offset;
		const payload = getPayloadFromSource(source, currentTimestamp);
		if (!payload) {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			setSignUrl(payload);
			setExpireAt(currentTimestamp + AUTO_QR_TTL_MS);
			setQrDataUrl(imageUrl);
			return true;
		} catch {
			setQrDataUrl("");
			setSignUrl("");
			setExpireAt(0);
			setExpireCountdown(0);
			return false;
		}
	};

	const getStatusBannerClassName = (kind: StatusKind): string => {
		if (kind === "error") {
			return "status-banner--error";
		}
		if (kind === "success") {
			return "status-banner--success";
		}
		if (kind === "info") {
			return "status-banner--info";
		}
		if (kind === "loading") {
			return "status-banner--loading";
		}
		return "status-banner--neutral";
	};

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");

		const applyTheme = () => {
			const resolved = themeMode === "system" ? (media.matches ? "dark" : "light") : themeMode;
			document.documentElement.setAttribute("data-theme", resolved);
			setResolvedTheme(resolved);
		};

		applyTheme();
		const onMediaChange = () => {
			if (themeMode === "system") {
				applyTheme();
			}
		};

		media.addEventListener("change", onMediaChange);
		window.localStorage.setItem("ucas-theme-mode", themeMode);

		return () => {
			media.removeEventListener("change", onMediaChange);
		};
	}, [themeMode]);

	useEffect(() => {
		const controller = new AbortController();
		const cached = readRepoStarsCache();

		if (cached) {
			setRepoStars(cached.stars);
			if (Date.now() - cached.updatedAt < REPO_STARS_CACHE_TTL_MS) {
				return () => {
					controller.abort();
				};
			}
		}

		const loadRepoStars = async () => {
			try {
				const res = await fetch("https://api.github.com/repos/lccipher/UCAS-Course-Sign-in", {
					signal: controller.signal,
					headers: {
						Accept: "application/vnd.github+json",
					},
				});

				if (!res.ok) {
					return;
				}

				const data = (await res.json()) as { stargazers_count?: number };
				if (typeof data.stargazers_count === "number") {
					setRepoStars(data.stargazers_count);
					writeRepoStarsCache(data.stargazers_count);
				}
			} catch {}
		};

		void loadRepoStars();

		return () => {
			controller.abort();
		};
	}, []);

	useEffect(() => {
		if (!expireAt) {
			setExpireCountdown(0);
			return;
		}

		const updateCountdown = () => {
			const remainMs = expireAt - (Date.now() + (timeOffsetRef.current || 0));
			setExpireCountdown(Math.max(0, Math.ceil(remainMs / 1000)));
		};

		updateCountdown();
		const timer = window.setInterval(updateCountdown, 250);

		return () => {
			window.clearInterval(timer);
		};
	}, [expireAt]);

	useEffect(() => {
		if (!qrSource || !expireAt) {
			return;
		}

		const delay = Math.max(0, expireAt - (Date.now() + (timeOffsetRef.current || 0)));
		const timer = window.setTimeout(async () => {
			const ok = await regenerateAutoQr(qrSource);
			if (!ok) {
				if (qrSource.mode === "query") {
					updateActionStatus("error", "签到码自动刷新失败，请重新选择课程");
				} else {
					updateStatus("error", "签到码自动刷新失败，请重新生成");
				}
			}
		}, delay);

		return () => {
			window.clearTimeout(timer);
		};
	}, [qrSource, expireAt]);

	const deferredKeyword = useDeferredValue(keyword);

	const filteredCourses = useMemo(() => {
		const word = deferredKeyword.trim().toLowerCase();
		if (!word) {
			return courses;
		}
		return courses.filter((item) => {
			return item.courseName.toLowerCase().includes(word) || item.teacherName.toLowerCase().includes(word);
		});
	}, [courses, deferredKeyword]);

	const hasCourses = courses.length > 0;
	const hasQr = Boolean(qrDataUrl);
	const queryAttempted = statusKind !== "idle";
	const hasKeyword = keyword.trim().length > 0;
	const emptyHelpText = hasKeyword ? "可先清空筛选词，再查看全部课程" : "检查日期是否为上课日，并确认学号与密码正确";
	const isCourseSelected = (uuid: string): boolean => selectedUuid === uuid;

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setLoading(true);
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setExpireCountdown(0);
		setQrSource(null);
		updateStatus("loading", "正在查询课程…");

		try {
			const res = await fetch("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: username.trim(),
					password,
					date: toYyyyMMdd(date),
				}),
			});

			const data = (await res.json()) as QueryResponse & { message?: string };

			if (!res.ok) {
				setCourses([]);
				updateStatus("error", data.message ?? "查询失败，请重试");
				return;
			}

			setCourses(data.courses ?? []);
			updateStatus("success", `已查询到 ${data.total} 门课程（${data.date}）`);
		} catch {
			setCourses([]);
			updateStatus("error", "网络异常，请稍后重试");
		} finally {
			setLoading(false);
		}
	};

	const onPick = async (uuid: string, courseId: string) => {
		setSelectedUuid(uuid);
		const source: QrSource = { mode: "query", uuid, courseId };
		setQrSource(source);

		const ok = await regenerateAutoQr(source);
		if (!ok) {
			updateActionStatus("error", "签到码生成失败，请重新选择课程");
			return;
		}

		updateActionStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
			updateActionStatus("info", "已生成签到码");
		}
	};

	const onManualGenerate = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const source: QrSource = { mode: "manual", identifier: manualIdentifier };
		const payload = getPayloadFromSource(source, Date.now() + (timeOffsetRef.current || 0));

		if (!payload) {
			updateStatus("error", "请输入纯数字课程ID或32位UUID");
			return;
		}

		setManualLoading(true);
		setSelectedUuid("");
		setQrSource(source);

		let ok = false;
		try {
			ok = await regenerateAutoQr(source);
		} finally {
			setManualLoading(false);
		}

		if (!ok) {
			updateStatus("error", "签到码生成失败，请检查课程ID或UUID后重试");
			return;
		}

		updateStatus("success", "签到码已生成（5秒后自动刷新）");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	};

	const onDownloadQr = async () => {
		if (!qrSource) {
			return;
		}

		const offset = await getServerTimeOffset();
		const deadline = Date.now() + offset + DOWNLOAD_QR_TTL_MS;
		const payload = getPayloadFromSource(qrSource, deadline);
		if (!payload) {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请重新生成签到码");
				return;
			}
			updateStatus("error", "下载二维码失败，请重新生成签到码");
			return;
		}

		try {
			const imageUrl = await generateQrDataUrlFromPayload(payload);
			const link = document.createElement("a");
			link.href = imageUrl;
			const safeIdentifier = getSignIdentifierForFilename(payload, selectedUuid);
			link.download = `ucas-signin-${safeIdentifier}-${deadline}.png`;
			link.click();
			if (featureMode === "query") {
				updateActionStatus("success", "二维码已开始下载（10秒有效）");
				return;
			}
			updateStatus("success", "二维码已开始下载（10秒有效）");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "下载二维码失败，请稍后重试");
				return;
			}
			updateStatus("error", "下载二维码失败，请稍后重试");
		}
	};

	const onCopySignUrl = async () => {
		if (!signUrl) {
			return;
		}

		try {
			await navigator.clipboard.writeText(signUrl);
			if (featureMode === "query") {
				updateActionStatus("info", "已复制签到链接");
				return;
			}
			updateStatus("info", "已复制签到链接");
		} catch {
			if (featureMode === "query") {
				updateActionStatus("error", "复制签到链接失败，请手动复制");
				return;
			}
			updateStatus("error", "复制签到链接失败，请手动复制");
		}
	};

	const refreshCoursesAfterSign = async (): Promise<{ ok: true; total: number } | { ok: false }> => {
		try {
			const res = await fetch("/api/course-uuid/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: username.trim(),
					password,
					date: toYyyyMMdd(date),
				}),
			});

			const data = (await res.json()) as QueryResponse & { message?: string };
			if (!res.ok) {
				return { ok: false };
			}

			setCourses(data.courses ?? []);
			return { ok: true, total: data.total ?? (data.courses ?? []).length };
		} catch {
			return { ok: false };
		}
	};

	const onDirectSign = async () => {
		if (directSignBlockedByTime) {
			updateActionStatus("error", "当前不在签到时间（开课前30分钟至下课前可签到）");
			return;
		}

		const courseSchedId =
			selectedCourse?.id ||
			(() => {
				try {
					const url = new URL(signUrl);
					return url.searchParams.get("courseSchedId") ?? url.searchParams.get("timeTableId") ?? "";
				} catch {
					return "";
				}
			})();

		if (!courseSchedId) {
			updateActionStatus("error", "请先在查询课程模式选择课程并生成签到码");
			return;
		}

		const safeUsername = username.trim();
		if (!safeUsername || !password) {
			updateActionStatus("error", "请先输入学号和密码");
			return;
		}

		setDirectSignLoading(true);
		updateActionStatus("loading", "正在发起签到…");

		try {
			const offset = await getServerTimeOffset();
			const res = await fetch("/api/course-uuid/sign", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: safeUsername,
					password,
					courseSchedId,
					timestamp: Date.now() + offset,
				}),
			});

			const data = (await res.json()) as DirectSignResponse;

			if (!res.ok || !data.success) {
				updateActionStatus("error", data.message ?? "签到失败，请稍后重试");
				return;
			}

			const signIdText = data.result?.stuSignId ? `（签到记录 ${data.result.stuSignId}）` : "";
			const refreshed = await refreshCoursesAfterSign();
			if (refreshed.ok) {
				updateActionStatus("success", `${data.message ?? "签到成功"}${signIdText}，课程状态已刷新`);
			} else {
				updateActionStatus(
					"info",
					`${data.message ?? "签到成功"}${signIdText}，但课程状态刷新失败，请手动查询`,
				);
			}
		} catch {
			updateActionStatus("error", "网络异常，签到请求未完成");
		} finally {
			setDirectSignLoading(false);
		}
	};

	const onToggleTheme = () => {
		setThemeMode(resolvedTheme === "dark" ? "light" : "dark");
	};

	const selectedCourse = useMemo(() => {
		if (!selectedUuid) {
			return null;
		}
		return courses.find((item) => item.uuid === selectedUuid) ?? null;
	}, [courses, selectedUuid]);

	const now = Date.now() + (timeOffsetRef.current || 0);

	const signWindow = useMemo(() => {
		if (!selectedCourse) {
			return null;
		}

		const classBegin = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classBeginTime));
		const classEnd = buildDateTimeFromClock(date, extractClockTime(selectedCourse.classEndTime));
		if (!classBegin || !classEnd) {
			return null;
		}

		const openAt = new Date(classBegin.getTime() - 30 * 60 * 1000);
		return {
			openAt: openAt.getTime(),
			closeAt: classEnd.getTime(),
		};
	}, [selectedCourse, date]);

	const directSignBlockedByTime = Boolean(
		selectedCourse && (!signWindow || now < signWindow.openAt || now > signWindow.closeAt),
	);

	const directSignDisabled = loading || directSignLoading || !hasQr || !selectedUuid || directSignBlockedByTime;

	const directSignButtonText = directSignLoading
		? "签到中..."
		: directSignBlockedByTime
			? "不在签到时间"
			: "点击签到";

	return (
		<>
			<div className="grain flex min-h-screen flex-col px-4 py-7 sm:px-10">
				<main className="mx-auto w-full max-w-6xl">
					<header className="mb-7">
						<a href="#main-content" className="sr-only focus:not-sr-only skip-link">
							跳到主要内容
						</a>
						<div className="mt-4">
							<h1 className="max-w-4xl font-[var(--font-serif)] text-3xl leading-tight font-semibold sm:text-5xl">
								UCAS Course Sign in
							</h1>
						</div>
						<p className="mt-4 text-sm leading-7 sm:text-base">
							查询课程，选择课程后可直接签到或下载签到码。也可以手动输入课程ID或UUID生成签到码。每个签到码每5秒自动刷新，下载二维码10秒有效。
						</p>
						<div className="utility-toolbar mt-4 flex flex-wrap items-center gap-2.5">
							<div className="repo-link-group inline-flex min-h-11 items-stretch">
								<a
									href={repoUrl}
									target="_blank"
									rel="noreferrer"
									className="repo-link-main inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold sm:text-sm"
									aria-label="查看 GitHub 仓库"
									title="查看 GitHub 仓库"
								>
									<svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
										<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.55 7.55 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
									</svg>
									<span>GitHub</span>
									<svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 fill-current">
										<path d="m10 1.5 2.42 4.9 5.4.78-3.9 3.8.92 5.37L10 13.9l-4.84 2.55.92-5.37-3.9-3.8 5.4-.78L10 1.5Z" />
									</svg>
									<span className="numeric-tabular">
										{repoStars !== null ? repoStars.toLocaleString() : "--"}
									</span>
								</a>
							</div>
							<button
								type="button"
								onClick={onToggleTheme}
								className="theme-toggle-compact inline-flex min-h-11 items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold sm:text-sm"
								aria-pressed={resolvedTheme === "dark"}
								aria-label={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
								title={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
							>
								<svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4 fill-current">
									{resolvedTheme === "dark" ? (
										<path d="M12 3a1 1 0 0 1 1 1v1.2a1 1 0 1 1-2 0V4a1 1 0 0 1 1-1Zm0 14.8a1 1 0 0 1 1 1V20a1 1 0 1 1-2 0v-1.2a1 1 0 0 1 1-1Zm8-5.8a1 1 0 0 1 1 1 1 1 0 0 1-1 1h-1.2a1 1 0 1 1 0-2H20ZM5.2 12a1 1 0 1 1 0 2H4a1 1 0 1 1 0-2h1.2Zm11.2-5.66a1 1 0 0 1 1.42 0l.85.85a1 1 0 1 1-1.41 1.42l-.86-.85a1 1 0 0 1 0-1.42Zm-10.24 0a1 1 0 0 1 1.42 1.42l-.86.85A1 1 0 0 1 5.33 7.2l.85-.85Zm11.39 10.24.85.85a1 1 0 1 1-1.41 1.42l-.86-.85a1 1 0 1 1 1.42-1.42Zm-10.24 0a1 1 0 0 1 0 1.42l-.86.85a1 1 0 1 1-1.41-1.42l.85-.85a1 1 0 0 1 1.42 0ZM12 7a5 5 0 1 1 0 10 5 5 0 0 1 0-10Z" />
									) : (
										<path d="M21.75 15.08a.75.75 0 0 0-.95-.46 8.23 8.23 0 0 1-2.62.43 8.24 8.24 0 0 1-8.23-8.23c0-.9.14-1.77.43-2.62a.75.75 0 0 0-.95-.95A9.75 9.75 0 1 0 21.3 16.03a.75.75 0 0 0 .45-.95Z" />
									)}
								</svg>
								<span>{resolvedTheme === "dark" ? "切换亮色" : "切换暗色"}</span>
							</button>
						</div>
						<div className="mt-4 flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("query");
									updateStatus("idle", "输入学号、密码和日期，开始查询课程");
								}}
								className={`action-btn min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold sm:text-sm ${
									featureMode === "query" ? "action-btn--primary" : "action-btn--secondary"
								}`}
							>
								查询课程模式
							</button>
							<button
								type="button"
								onClick={() => {
									resetGeneratedSignState();
									setFeatureMode("manual");
									updateStatus("idle", "输入课程ID或UUID，直接生成签到码");
								}}
								className={`action-btn min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold sm:text-sm ${
									featureMode === "manual" ? "action-btn--primary" : "action-btn--secondary"
								}`}
							>
								手动生成模式
							</button>
						</div>
					</header>

					{featureMode === "query" ? (
						<section
							id="main-content"
							className="grid items-start gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]"
						>
							<form onSubmit={onSubmit} className="panel rounded-2xl p-5 sm:p-6">
								<div className="space-y-1">
									<h2 className="font-[var(--font-serif)] text-2xl font-semibold">查询课程</h2>
									<p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
										学号和密码仅用于本次查询，不会存储
									</p>
								</div>

								<div className="mt-6 space-y-4">
									<label className="block text-sm font-semibold">
										学号
										<input
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="studentId"
											value={username}
											onChange={(e) => setUsername(e.target.value)}
											autoComplete="username"
											spellCheck={false}
											required
										/>
									</label>

									<label className="block text-sm font-semibold">
										密码
										<input
											type="password"
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="password"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											autoComplete="current-password"
											required
										/>
									</label>

									<label className="block text-sm font-semibold">
										日期
										<input
											type="date"
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="courseDate"
											value={date}
											onChange={(e) => setDate(e.target.value)}
											required
										/>
									</label>

									<button
										disabled={loading}
										className="action-btn action-btn--primary w-full rounded-xl px-4 py-3 text-sm font-semibold"
										type="submit"
									>
										{loading ? "查询中..." : "查询课程"}
									</button>
								</div>

								<p
									role="status"
									aria-live={statusKind === "error" ? "assertive" : "polite"}
									aria-atomic="true"
									className={`status-banner mt-4 rounded-xl px-3 py-2 text-sm leading-6 ${getStatusBannerClassName(statusKind)}`}
								>
									{statusText}
								</p>
							</form>

							<div className="panel rounded-2xl p-5 sm:p-6">
								<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
									<h2 className="font-[var(--font-serif)] text-2xl font-semibold">选择课程</h2>
									{hasCourses ? (
										<input
											className="focus-ring input-surface min-h-11 w-full rounded-xl border border-[color:var(--line)] px-4 py-2 text-sm md:w-auto md:min-w-[230px]"
											name="courseFilter"
											aria-label="筛选课程"
											value={keyword}
											onChange={(e) => setKeyword(e.target.value)}
											placeholder="输入课程名或教师姓名进行筛选"
										/>
									) : null}
								</div>

								<div className="mt-4 space-y-4">
									<div className="space-y-3 lg:hidden">
										{filteredCourses.length === 0 ? (
											<div className="clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] px-4 py-8 text-center text-sm text-[color:var(--green)]">
												<p>暂无课程数据</p>
												{queryAttempted ? (
													<p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">
														{emptyHelpText}
													</p>
												) : null}
											</div>
										) : (
											filteredCourses.map((course) => {
												const selected = isCourseSelected(course.uuid);
												return (
													<article
														key={`${course.id}-${course.uuid}`}
														className={`course-item clay-card rounded-xl border p-4 ${
															selected
																? "course-item--selected border-[color:var(--line-strong)] bg-[color:var(--paper-strong)]"
																: "border-[color:var(--line)] bg-[color:var(--surface-raised)]"
														}`}
													>
														<div className="flex items-start justify-between gap-3">
															<div className="min-w-0">
																<h3 className="text-sm font-semibold leading-6 break-words">
																	{course.courseName || "--"}
																</h3>
															</div>
															<span
																className={`status-chip rounded-md border px-2 py-1 text-xs ${
																	course.signStatus === "1"
																		? "status-chip--signed"
																		: "status-chip--unsigned"
																}`}
															>
																{course.signStatus === "1" ? "已签到" : "未签到"}
															</span>
														</div>
														<dl className="mt-2 grid grid-cols-[40px_1fr] gap-x-2 gap-y-1 text-xs text-[color:var(--muted)]">
															<dt className="font-medium">教师</dt>
															<dd className="break-words">
																{course.teacherName || "--"}
															</dd>
															<dt className="font-medium">时段</dt>
															<dd className="break-words">
																{formatRange(
																	course.classBeginTime,
																	course.classEndTime,
																)}
															</dd>
														</dl>
														<button
															type="button"
															onClick={() => onPick(course.uuid, course.id)}
															className="action-btn action-btn--secondary mt-3 w-full min-h-11 rounded-lg px-3.5 py-2 text-sm font-semibold"
														>
															{selected ? "已选中" : "生成签到码"}
														</button>
													</article>
												);
											})
										)}
									</div>

									<div className="render-skip clay-card hidden overflow-x-auto rounded-xl border border-[color:var(--line)] bg-[color:var(--surface-raised)] lg:block">
										<table className="min-w-full text-sm">
											<caption className="sr-only">课程查询结果和签到码生成操作</caption>
											<thead className="bg-[color:var(--paper-strong)] text-left text-[color:var(--muted)]">
												<tr>
													<th className="px-3 py-3">课程</th>
													<th className="px-3 py-3">教师</th>
													<th className="px-3 py-3">时段</th>
													<th className="px-3 py-3">状态</th>
													<th className="px-3 py-3">操作</th>
												</tr>
											</thead>
											<tbody>
												{filteredCourses.length === 0 ? (
													<tr>
														<td
															colSpan={5}
															className="px-3 py-8 text-center text-[color:var(--green)]"
														>
															<p>暂无课程数据</p>
															{queryAttempted ? (
																<p className="mt-2 text-xs leading-5 text-[color:var(--muted)]">
																	{emptyHelpText}
																</p>
															) : null}
														</td>
													</tr>
												) : (
													filteredCourses.map((course) => {
														const selected = isCourseSelected(course.uuid);
														return (
															<tr
																key={`${course.id}-${course.uuid}`}
																className={`course-row ${
																	selected
																		? "bg-[color:var(--paper-strong)]"
																		: "bg-[color:var(--surface-raised)]"
																}`}
															>
																<td className="max-w-[170px] px-3 py-3 font-medium break-words">
																	{course.courseName || "--"}
																</td>
																<td className="px-3 py-3">
																	{course.teacherName || "--"}
																</td>
																<td className="max-w-[180px] px-3 py-3 break-words">
																	{formatRange(
																		course.classBeginTime,
																		course.classEndTime,
																	)}
																</td>
																<td className="px-3 py-3">
																	<span
																		className={`status-chip rounded-md border px-2 py-1 text-xs ${
																			course.signStatus === "1"
																				? "status-chip--signed"
																				: "status-chip--unsigned"
																		}`}
																	>
																		{course.signStatus === "1"
																			? "已签到"
																			: "未签到"}
																	</span>
																</td>
																<td className="px-3 py-3">
																	<button
																		type="button"
																		onClick={() => onPick(course.uuid, course.id)}
																		className="action-btn action-btn--secondary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
																	>
																		{selected ? "已选中" : "生成签到码"}
																	</button>
																</td>
															</tr>
														);
													})
												)}
											</tbody>
										</table>
									</div>

									<div
										ref={qrSectionRef}
										className={`render-skip clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface)] p-4 ${
											qrRelayActive ? "relay-highlight" : ""
										}`}
									>
										{hasQr ? (
											<div className="grid gap-4 lg:grid-cols-[220px_1fr] lg:items-center">
												<Image
													src={qrDataUrl}
													alt="签到码"
													width={220}
													height={220}
													unoptimized
													className="w-[220px] max-w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-raised)] p-2"
												/>
												<div className="space-y-3 text-sm numeric-tabular">
													<p>
														刷新倒计时：
														<span className="font-semibold">{expireCountdown}s</span>
													</p>
													<p className="break-all font-mono text-xs leading-6 text-[color:var(--muted)]">
														{signUrl}
													</p>
													<div className="flex flex-wrap gap-2">
														<button
															type="button"
															onClick={onDirectSign}
															disabled={directSignDisabled}
															className="action-btn action-btn--primary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
														>
															{directSignButtonText}
														</button>
														<button
															type="button"
															onClick={onDownloadQr}
															className="action-btn action-btn--secondary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
														>
															下载二维码
														</button>
														<button
															type="button"
															onClick={onCopySignUrl}
															className="action-btn action-btn--quiet min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
														>
															复制签到链接
														</button>
													</div>
													<p
														role="status"
														aria-live={
															actionStatusKind === "error" ? "assertive" : "polite"
														}
														aria-atomic="true"
														className={`status-banner rounded-xl px-3 py-2 text-xs leading-6 ${getStatusBannerClassName(actionStatusKind)}`}
													>
														{actionStatusText}
													</p>
												</div>
											</div>
										) : (
											<p className="text-sm text-center text-[color:var(--green)]">
												暂无签到码数据
											</p>
										)}
									</div>
								</div>
							</div>
						</section>
					) : (
						<section
							id="main-content"
							className="grid items-start gap-5 xl:grid-cols-[minmax(320px,380px)_minmax(0,1fr)] 2xl:grid-cols-[minmax(340px,400px)_minmax(0,1fr)]"
						>
							<form onSubmit={onManualGenerate} className="panel rounded-2xl p-5 sm:p-6">
								<div className="space-y-1">
									<h2 className="font-[var(--font-serif)] text-2xl font-semibold">手动生成签到码</h2>
									<p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
										课程ID为7位纯数字，UUID为32位十六进制字符串
									</p>
								</div>

								<div className="mt-6 space-y-4">
									<label className="block text-sm font-semibold">
										课程ID / UUID
										<input
											className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
											name="manualCourseIdentifier"
											value={manualIdentifier}
											onChange={(e) => setManualIdentifier(e.target.value)}
											placeholder="1203879 / EFD843630CE444769921BDDCD05298C7"
											autoComplete="off"
											spellCheck={false}
											required
										/>
									</label>

									<button
										disabled={manualLoading}
										className="action-btn action-btn--primary w-full rounded-xl px-4 py-3 text-sm font-semibold"
										type="submit"
									>
										{manualLoading ? "生成中..." : "生成签到码"}
									</button>
								</div>

								<p
									role="status"
									aria-live={statusKind === "error" ? "assertive" : "polite"}
									aria-atomic="true"
									className={`status-banner mt-4 rounded-xl px-3 py-2 text-sm leading-6 ${getStatusBannerClassName(statusKind)}`}
								>
									{statusText}
								</p>
							</form>

							<div
								ref={qrSectionRef}
								className={`render-skip clay-card rounded-xl border border-[color:var(--line)] bg-[color:var(--surface)] p-4 ${
									qrRelayActive ? "relay-highlight" : ""
								}`}
							>
								{hasQr ? (
									<div className="grid gap-4 lg:grid-cols-[220px_1fr] lg:items-center">
										<Image
											src={qrDataUrl}
											alt="签到码"
											width={220}
											height={220}
											unoptimized
											className="w-[220px] max-w-full rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-raised)] p-2"
										/>
										<div className="space-y-3 text-sm numeric-tabular">
											<p>
												刷新倒计时：
												<span className="font-semibold">{expireCountdown}s</span>
											</p>
											<p className="break-all font-mono text-xs leading-6 text-[color:var(--muted)]">
												{signUrl}
											</p>
											<div className="flex flex-wrap gap-2">
												<button
													type="button"
													onClick={onDownloadQr}
													className="action-btn action-btn--secondary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
												>
													下载二维码
												</button>
												<button
													type="button"
													onClick={onCopySignUrl}
													className="action-btn action-btn--quiet min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
												>
													复制签到链接
												</button>
											</div>
										</div>
									</div>
								) : (
									<p className="text-sm text-center text-[color:var(--green)]">暂无签到码数据</p>
								)}
							</div>
						</section>
					)}
				</main>
			</div>
		</>
	);
}
