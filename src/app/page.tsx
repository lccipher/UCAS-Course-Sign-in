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

const ACTION_STATUS_DEFAULT_TEXT = "生成签到码后，可在此查看下载、复制和点击签到的状态信息";

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

function buildSignInUrl(uuid: string, expiresAt: number): string {
	return `http://124.16.75.106:8081/app/course/stu_scan_sign.action?timeTableId=${encodeURIComponent(uuid)}&timestamp=${expiresAt}`;
}

function buildManualSignInUrl(identifier: string, expiresAt: number): string | null {
	const raw = identifier.trim();
	if (!raw) {
		return null;
	}

	if (/^\d+$/.test(raw)) {
		return `https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action?courseSchedId=${encodeURIComponent(raw)}&timestamp=${expiresAt}`;
	}

	const compact = raw.replace(/-/g, "");
	if (/^[0-9a-fA-F]{32}$/.test(compact)) {
		return `https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action?timeTableId=${encodeURIComponent(compact.toUpperCase())}&timestamp=${expiresAt}`;
	}

	return null;
}

function getSignIdentifierForFilename(signUrl: string, selectedUuid: string): string {
	if (selectedUuid) {
		return selectedUuid;
	}

	if (!signUrl) {
		return "unknown";
	}

	try {
		const url = new URL(signUrl);
		const timeTableId = url.searchParams.get("timeTableId");
		if (timeTableId) {
			return timeTableId;
		}

		const courseSchedId = url.searchParams.get("courseSchedId");
		if (courseSchedId) {
			return courseSchedId;
		}
	} catch {
		return "unknown";
	}

	return "unknown";
}

function formatDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
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
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		setStatusText(message);
	};

	const updateActionStatus = (kind: StatusKind, message: string) => {
		setActionStatusKind(kind);
		setActionStatusText(message);
	};

	const resetGeneratedSignState = () => {
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
		setQrRelayActive(false);
		setActionStatusKind("idle");
		setActionStatusText(ACTION_STATUS_DEFAULT_TEXT);
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
				}
			} catch {
				// Ignore network/rate-limit failures and keep the plain repo link.
			}
		};

		void loadRepoStars();

		return () => {
			controller.abort();
		};
	}, []);

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

	const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setLoading(true);
		setSelectedUuid("");
		setSignUrl("");
		setQrDataUrl("");
		setExpireAt(0);
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

	const onPick = async (uuid: string) => {
		setSelectedUuid(uuid);
		const deadline = Date.now() + 30 * 60 * 1000;
		const payload = buildSignInUrl(uuid, deadline);

		setSignUrl(payload);
		setExpireAt(deadline);

		try {
			const { default: QRCode } = await import("qrcode");
			const imageUrl = await QRCode.toDataURL(payload, {
				width: 320,
				margin: 1,
				errorCorrectionLevel: "M",
			});
			setQrDataUrl(imageUrl);
		} catch {
			setQrDataUrl("");
			updateActionStatus("error", "签到码生成失败，请重新选择课程");
			return;
		}

		updateActionStatus("success", "签到码已生成，可点击签到或下载二维码");

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
		const deadline = Date.now() + 30 * 60 * 1000;
		const payload = buildManualSignInUrl(manualIdentifier, deadline);

		if (!payload) {
			updateStatus("error", "请输入纯数字课程ID或32位UUID");
			return;
		}

		setManualLoading(true);
		setSelectedUuid("");
		setSignUrl(payload);
		setExpireAt(deadline);

		try {
			const { default: QRCode } = await import("qrcode");
			const imageUrl = await QRCode.toDataURL(payload, {
				width: 320,
				margin: 1,
				errorCorrectionLevel: "M",
			});
			setQrDataUrl(imageUrl);
		} catch {
			setQrDataUrl("");
			updateStatus("error", "签到码生成失败，请检查课程ID或UUID后重试");
			return;
		} finally {
			setManualLoading(false);
		}

		updateStatus("success", "签到码已生成");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	};

	const onDownloadQr = () => {
		if (!qrDataUrl) {
			return;
		}

		const link = document.createElement("a");
		link.href = qrDataUrl;
		const safeIdentifier = getSignIdentifierForFilename(signUrl, selectedUuid);
		link.download = `ucas-signin-${safeIdentifier}-${expireAt}.png`;
		link.click();
		if (featureMode === "query") {
			updateActionStatus("success", "二维码已开始下载");
			return;
		}
		updateStatus("success", "二维码已开始下载");
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
		const timeTableId =
			selectedUuid ||
			(() => {
				try {
					const url = new URL(signUrl);
					return url.searchParams.get("timeTableId") ?? "";
				} catch {
					return "";
				}
			})();

		if (!timeTableId) {
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
			const res = await fetch("/api/course-uuid/sign", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					username: safeUsername,
					password,
					timeTableId,
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

	const directSignDisabled = loading || directSignLoading || !hasQr || !selectedUuid;

	return (
		<div className="grain flex min-h-screen flex-col px-4 py-7 sm:px-10">
			<main className="mx-auto w-full max-w-6xl">
				<header className="mb-7">
					<a href="#main-content" className="sr-only focus-not-sr-only skip-link">
						跳到主要内容
					</a>
					<div className="mt-4">
						<h1 className="max-w-4xl font-[var(--font-serif)] text-3xl leading-tight font-semibold sm:text-5xl">
							UCAS Course Sign in
						</h1>
					</div>
					<p className="mt-4 text-sm leading-7 sm:text-base">
						查询课程，选择课程后可直接签到或下载签到码。也可以手动输入课程ID或UUID，生成签到码。每个签到码
						30 分钟后失效。
					</p>
					<div className="utility-toolbar mt-4 flex flex-wrap items-center gap-2.5">
						<div className="repo-link-group inline-flex min-h-11 items-stretch">
							<a
								href={repoUrl}
								target="_blank"
								rel="noreferrer"
								className="repo-link-main inline-flex min-h-11 items-center gap-2 rounded-l-xl rounded-r-none px-3.5 py-2 text-xs font-semibold sm:text-sm"
								aria-label="查看 GitHub 仓库"
								title="查看 GitHub 仓库"
							>
								<svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 fill-current">
									<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.1 0 0 .67-.21 2.2.82a7.55 7.55 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.09.16 1.9.08 2.1.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
								</svg>
								<span>GitHub 仓库</span>
							</a>
							<a
								href={`${repoUrl}/stargazers`}
								target="_blank"
								rel="noreferrer"
								className="repo-link-stars -ml-px inline-flex min-h-11 items-center gap-1.5 rounded-l-none rounded-r-xl px-3 py-2 text-xs font-semibold sm:text-sm"
								aria-label="查看仓库 Star"
								title="查看仓库 Star"
							>
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
											const selected = selectedUuid === course.uuid;
											return (
												<article
													key={`${course.id}-${course.uuid}`}
													aria-current={selected ? "true" : undefined}
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
														<dd className="break-words">{course.teacherName || "--"}</dd>
														<dt className="font-medium">时段</dt>
														<dd className="break-words">
															{formatRange(course.classBeginTime, course.classEndTime)}
														</dd>
													</dl>
													<button
														type="button"
														onClick={() => onPick(course.uuid)}
														className="action-btn action-btn--secondary mt-3 w-full min-h-11 rounded-lg px-3.5 py-2 text-sm font-semibold"
													>
														{selected ? "已选中，重新生成签到码" : "生成签到码"}
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
													const selected = selectedUuid === course.uuid;
													return (
														<tr
															key={`${course.id}-${course.uuid}`}
															aria-current={selected ? "true" : undefined}
															className={`course-row ${
																selected
																	? "bg-[color:var(--paper-strong)]"
																	: "bg-[color:var(--surface-raised)]"
															}`}
														>
															<td className="max-w-[170px] px-3 py-3 font-medium break-words">
																{course.courseName || "--"}
															</td>
															<td className="px-3 py-3">{course.teacherName || "--"}</td>
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
																	{course.signStatus === "1" ? "已签到" : "未签到"}
																</span>
															</td>
															<td className="px-3 py-3">
																<button
																	type="button"
																	onClick={() => onPick(course.uuid)}
																	className="action-btn action-btn--secondary min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
																>
																	{selected ? "已选中，重新生成签到码" : "生成签到码"}
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
													有效期截止：
													<span className="font-semibold">{formatDateTime(expireAt)}</span>
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
														{directSignLoading ? "签到中..." : "点击签到"}
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
													aria-live={actionStatusKind === "error" ? "assertive" : "polite"}
													aria-atomic="true"
													className={`status-banner rounded-xl px-3 py-2 text-xs leading-6 ${getStatusBannerClassName(actionStatusKind)}`}
												>
													{actionStatusText}
												</p>
											</div>
										</div>
									) : (
										<p className="text-sm text-center text-[color:var(--green)]">暂无签到码数据</p>
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
							</div>

							<div className="mt-6 space-y-4">
								<label className="block text-sm font-semibold">
									课程ID / UUID
									<input
										className="focus-ring input-surface mt-2 w-full rounded-xl border border-[color:var(--line)] px-4 py-2.5"
										name="manualCourseIdentifier"
										value={manualIdentifier}
										onChange={(e) => setManualIdentifier(e.target.value.trim())}
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
											有效期截止：
											<span className="font-semibold">{formatDateTime(expireAt)}</span>
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
	);
}
