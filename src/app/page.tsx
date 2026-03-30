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

type ThemeMode = "system" | "light" | "dark";
type StatusKind = "idle" | "loading" | "success" | "error" | "info";

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

function formatDateTime(timestamp: number): string {
	return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
}

export default function Home() {
	const [themeMode, setThemeMode] = useState<ThemeMode>(getSavedThemeMode);
	const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [date, setDate] = useState(getTodayInputDate);
	const [keyword, setKeyword] = useState("");
	const [courses, setCourses] = useState<CourseItem[]>([]);
	const [selectedUuid, setSelectedUuid] = useState("");
	const [statusText, setStatusText] = useState("输入学号、密码和日期，开始查询课程");
	const [statusKind, setStatusKind] = useState<StatusKind>("idle");
	const [loading, setLoading] = useState(false);
	const [signUrl, setSignUrl] = useState("");
	const [qrDataUrl, setQrDataUrl] = useState("");
	const [expireAt, setExpireAt] = useState(0);
	const [qrRelayActive, setQrRelayActive] = useState(false);
	const qrSectionRef = useRef<HTMLDivElement | null>(null);

	const updateStatus = (kind: StatusKind, message: string) => {
		setStatusKind(kind);
		setStatusText(message);
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
	const emptyHelpText = hasKeyword
		? "可先清空筛选词，再查看全部课程。"
		: "检查日期是否为上课日，并确认学号与密码正确。";

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
			updateStatus("error", "签到码生成失败，请重新选择课程");
			return;
		}

		updateStatus("success", "签到码已生成");

		if (window.matchMedia("(max-width: 1023px)").matches) {
			setQrRelayActive(true);
			window.setTimeout(() => setQrRelayActive(false), 1200);
			window.requestAnimationFrame(() => {
				qrSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
			});
			updateStatus("info", "已生成签到码");
		}
	};

	const onDownloadQr = () => {
		if (!qrDataUrl) {
			return;
		}

		const link = document.createElement("a");
		link.href = qrDataUrl;
		const safeUuid = selectedUuid || "unknown";
		link.download = `ucas-signin-${safeUuid}-${expireAt}.png`;
		link.click();
		updateStatus("success", "二维码已开始下载");
	};

	const onToggleTheme = () => {
		setThemeMode(resolvedTheme === "dark" ? "light" : "dark");
	};

	return (
		<div className="grain flex min-h-screen flex-col px-4 py-7 sm:px-10">
			<main className="mx-auto w-full max-w-6xl">
				<header className="mb-7">
					<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
						<p className="tag inline-block self-start rounded-full px-3 py-1 text-xs font-semibold tracking-[0.12em] uppercase">
							UCAS COURSE SIGN IN · QR GENERATOR
						</p>
						<button
							type="button"
							onClick={onToggleTheme}
							className="theme-toggle-compact self-end rounded-full px-2.5 py-1 text-[11px] font-semibold sm:self-auto"
							aria-pressed={resolvedTheme === "dark"}
							aria-label={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
							title={resolvedTheme === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
						>
							{resolvedTheme === "dark" ? "亮色" : "暗色"}
						</button>
					</div>
					<a href="#main-content" className="sr-only focus-not-sr-only skip-link">
						跳到主要内容
					</a>
					<h1 className="mt-4 max-w-3xl font-[var(--font-serif)] text-3xl leading-tight font-semibold sm:text-5xl">
						UCAS Course Sign in
					</h1>
					<p className="mt-4 max-w-2xl text-sm leading-7 sm:text-base">
						1. 查询课程。2. 选择课程。3. 使用签到码。每个签到码 30 分钟后失效。
					</p>
				</header>

				<section id="main-content" className="grid gap-5 lg:grid-cols-[400px_1fr]">
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
							className={`status-banner mt-4 rounded-xl px-3 py-2 text-sm leading-6 ${
								statusKind === "error"
									? "status-banner--error"
									: statusKind === "success"
										? "status-banner--success"
										: statusKind === "info"
											? "status-banner--info"
											: statusKind === "loading"
												? "status-banner--loading"
												: "status-banner--neutral"
							}`}
						>
							{statusText}
						</p>

						{statusKind === "error" ? (
							<div className="clay-card mt-2 rounded-lg border border-[color:var(--line)] bg-[color:var(--surface-raised)] px-3 py-2 text-xs leading-5 text-[color:var(--muted)]">
								<p>检查学号/密码，切换日期后重试；若仍失败，稍后再试。</p>
							</div>
						) : null}
					</form>

					<div className="panel rounded-2xl p-5 sm:p-6">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
							<h2 className="font-[var(--font-serif)] text-2xl font-semibold">选择课程</h2>
							{hasCourses ? (
								<input
									className="focus-ring input-surface rounded-xl border border-[color:var(--line)] px-4 py-2 text-sm"
									name="courseFilter"
									aria-label="筛选课程"
									value={keyword}
									onChange={(e) => setKeyword(e.target.value)}
									placeholder="筛选课程名或教师"
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
															{formatRange(course.classBeginTime, course.classEndTime)}
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
								<p className="text-xs tracking-[0.08em] uppercase text-[color:var(--green)]">
									使用签到码
								</p>
								{hasQr ? (
									<div className="mt-3 grid gap-4 lg:grid-cols-[220px_1fr] lg:items-start">
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
													onClick={async () => {
														if (!signUrl) {
															return;
														}
														try {
															await navigator.clipboard.writeText(signUrl);
															updateStatus("info", "已复制签到链接");
														} catch {
															updateStatus("error", "复制签到链接失败，请手动复制");
														}
													}}
													className="action-btn action-btn--quiet min-h-11 rounded-lg px-3.5 py-2 text-xs font-semibold"
												>
													复制签到链接
												</button>
											</div>
										</div>
									</div>
								) : (
									<p className="mt-2 text-sm">先选择课程，再生成签到码</p>
								)}
							</div>
						</div>
					</div>
				</section>
			</main>
		</div>
	);
}
