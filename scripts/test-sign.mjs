#!/usr/bin/env node

/**
 * UCAS 签到功能端到端测试脚本
 * ================================
 * 用法：
 *   node scripts/test-sign.mjs <学号> <密码> [课程ID] [--base-url http://localhost:3000]
 *
 * 示例：
 *   node scripts/test-sign.mjs 202511112222333 mypassword 1180610
 *   node scripts/test-sign.mjs 202511112222333 mypassword 1180610 --base-url https://my-site.vercel.app
 *
 * 测试内容：
 *   1. 时间戳校准 — 验证 UCAS 时间戳 API 可达且返回合法值
 *   2. 直接签到   — 绕过本地 API，直连 UCAS 签到接口
 *   3. API 签到    — 通过 /api/course-uuid/sign 完整链路签到
 *
 * 判断标准：
 *   - ERRCODE=101 / "未在上课时间" → ✅ 时间戳有效，签到功能正常
 *   - ERRCODE=100 / "参数错误"     → ❌ 时间戳被拒绝，签到功能异常
 * 
 *  # 本地测试（需要先启动 dev server）
    npm run dev &
    npm run test:sign <学号> <密码> [课程ID]

    # 示例
    npm run test:sign 202511112222333 mypassword 1180610

    # 测试生产环境
    node scripts/test-sign.mjs 202511112222333 mypassword 1180610 --base-url https://你的域名

    # 查看帮助
    node scripts/test-sign.mjs --help
 * 
 */

// ── 配置 ────────────────────────────────────────────────────
const UCAS_LOGIN_URL = "https://iclass.ucas.edu.cn:8181/app/user/login.action";
const UCAS_SIGN_URL = "https://iclass.ucas.edu.cn:8181/app/course/stu_scan_sign.action";
const UCAS_LOGIN_UA = "student_5.0.1.2_android_12_20__110000";
const UCAS_API_UA = "student_5.0.1.2_android_12_20_100000000000000_110000";
const SIGN_TIMESTAMP_BUFFER_MS = 5000; // 与 page.tsx 中 SIGN_TIMESTAMP_BUFFER_MS 保持一致
const REQUEST_TIMEOUT_MS = 15000;

// ── 参数解析 ────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    console.log(`
用法: node scripts/test-sign.mjs <学号> <密码> [课程ID] [选项]

参数:
  学号        UCAS 学号
  密码        UCAS 密码
  课程ID      7位课程ID（默认: 1180610）

选项:
  --base-url  API 基地址（默认: http://localhost:3000）
  --help      显示帮助

示例:
  node scripts/test-sign.mjs 202511112222333 mypass 1180610
  node scripts/test-sign.mjs 202511112222333 mypass 1180610 --base-url https://my.vercel.app
`);
    process.exit(0);
}

const username = args[0];
const password = args[1];
const courseSchedId = /^\d{7}$/.test(args[2] ?? "") ? args[2] : "1180610";
const baseUrlFlagIdx = args.indexOf("--base-url");
const baseUrl = baseUrlFlagIdx >= 0 ? args[baseUrlFlagIdx + 1]?.replace(/\/+$/, "") || "http://localhost:3000" : "http://localhost:3000";

// ── 工具函数 ────────────────────────────────────────────────
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;

function check(label, condition, detail = "") {
    if (condition) {
        console.log(`  ${GREEN}✓${RESET} ${label}${detail ? ` ${CYAN}${detail}${RESET}` : ""}`);
        passed++;
    } else {
        console.log(`  ${RED}✗${RESET} ${label}${detail ? ` ${RED}${detail}${RESET}` : ""}`);
        failed++;
    }
}

function info(msg) {
    console.log(`${CYAN}ℹ${RESET} ${msg}`);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(timer);
    }
}

// ── 构建登录请求体 ──────────────────────────────────────────
function buildLoginBody(phone, pwd) {
    const verificationUrl =
        "http://iclass.ucas.edu.cn:88/ve/webservices/mobileCheck.shtml?method=mobileLogin&username=${0}&password=${1}&lx=${2}";
    const params = new URLSearchParams({
        phone,
        password: pwd,
        verificationType: "1",
        verificationUrl,
        userLevel: "1",
    });
    return params.toString();
}

// ── 主测试流程 ──────────────────────────────────────────────
async function main() {
    console.log(`\n${BOLD}UCAS 签到功能测试${RESET}`);
    console.log(`  API 基地址 : ${baseUrl}`);
    console.log(`  课程 ID    : ${courseSchedId}`);
    console.log(`  时间戳缓冲 : ${SIGN_TIMESTAMP_BUFFER_MS}ms`);
    console.log("");

    // ─── 测试 1：时间戳校准 ───────────────────────────────────
    console.log(`${BOLD}测试 1：时间戳校准${RESET}`);
    let serverTimestamp = 0;
    let localTimestamp = Date.now();
    try {
        const tsStart = Date.now();
        const tsRes = await fetchWithTimeout(`${baseUrl}/api/course-uuid/timestamp`);
        const tsData = await tsRes.json();
        const tsLatency = Date.now() - tsStart;

        serverTimestamp = tsData.timestamp;
        localTimestamp = Date.now();

        check("API 返回 success=true", tsData.success === true, JSON.stringify(tsData));
        check(
            "时间戳为合法数字（> 1e12）",
            typeof tsData.timestamp === "number" && tsData.timestamp > 1e12,
            `timestamp=${tsData.timestamp}`
        );
        const drift = serverTimestamp - localTimestamp;
        check(
            "服务器与本地时差在 60s 以内",
            Math.abs(drift) < 60000,
            `偏差=${drift}ms`
        );
        info(`时间戳获取延迟: ${tsLatency}ms`);
    } catch (err) {
        check("时间戳 API 可达", false, err.message);
    }

    // 计算校准后的签到时间戳
    const signTimestamp = serverTimestamp > 0 ? serverTimestamp - SIGN_TIMESTAMP_BUFFER_MS : 0;
    info(`校准签到时间戳: ${signTimestamp} (serverTime - ${SIGN_TIMESTAMP_BUFFER_MS}ms)`);

    // ─── 测试 2：登录 UCAS ────────────────────────────────────
    console.log(`\n${BOLD}测试 2：UCAS 登录${RESET}`);
    let sessionId = "";
    let userId = "";

    try {
        const loginBody = buildLoginBody(username, password);
        const loginRes = await fetchWithTimeout(UCAS_LOGIN_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": UCAS_LOGIN_UA,
            },
            body: loginBody,
        });
        const loginData = await loginRes.json();
        sessionId = loginData?.result?.sessionId ?? "";
        userId = loginData?.result?.id ?? "";

        check("登录 STATUS=0", loginData?.STATUS === "0");
        check("获取到 sessionId", typeof sessionId === "string" && sessionId.length === 32);
        check("获取到 userId", typeof userId === "string" && userId.length > 0);
    } catch (err) {
        check("登录请求成功", false, err.message);
    }

    // ─── 测试 3：直接 UCAS 签到（绕开本地 API）───────────────
    console.log(`\n${BOLD}测试 3：直接 UCAS 签到（绕开本地 API）${RESET}`);

    let directResult = null;
    try {
        const signUrl = `${UCAS_SIGN_URL}?courseSchedId=${courseSchedId}&timestamp=${signTimestamp}&id=${userId}`;
        const signRes = await fetchWithTimeout(signUrl, {
            headers: {
                sessionId,
                "User-Agent": UCAS_API_UA,
            },
        });
        directResult = await signRes.json();

        const errcode = directResult?.ERRCODE ?? "";
        const errmsg = directResult?.ERRMSG ?? "";
        const status = directResult?.STATUS ?? "";

        check("收到 UCAS 响应", !!directResult);
        check(
            "ERRCODE ≠ 100（时间戳未被拒绝）",
            errcode !== "100",
            `ERRCODE=${errcode} ERRMSG="${errmsg}"`
        );
        check(
            "ERRCODE = 101 或 STATUS = 0（时间戳格式有效）",
            errcode === "101" || status === "0",
            `STATUS=${status} ERRCODE=${errcode} ERRMSG="${errmsg}"`
        );

        if (errcode === "100") {
            info(`${RED}时间戳被 UCAS 拒绝——签到功能存在 Bug！${RESET}`);
        } else if (errcode === "101") {
            info(`UCAS 业务层拒绝：${errmsg}（时间戳有效但不在上课时间）`);
        } else if (status === "0") {
            info(`${GREEN}签到成功！${RESET}`);
        }
    } catch (err) {
        check("签到请求成功", false, err.message);
    }

    // ─── 测试 4：API 签到（完整链路）──────────────────────────
    console.log(`\n${BOLD}测试 4：API 签到（/api/course-uuid/sign）${RESET}`);

    try {
        const apiRes = await fetchWithTimeout(`${baseUrl}/api/course-uuid/sign`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                username,
                password,
                courseSchedId,
                timestamp: signTimestamp,
            }),
        });

        const apiData = await apiRes.json();

        check("API 返回响应", !!apiData);
        check(
            "message 不含「参数错误」",
            !(apiData?.message ?? "").includes("参数错误"),
            `message="${apiData?.message}"`
        );
        check(
            "upstreamStatus 不是 ERRCODE=100",
            apiData?.upstreamStatus !== "100",
            `upstreamStatus=${apiData?.upstreamStatus}`
        );

        if (apiData?.success) {
            info(`${GREEN}签到成功！stuSignId=${apiData?.result?.stuSignId}${RESET}`);
        } else if ((apiData?.message ?? "").includes("未在上课时间") || (apiData?.message ?? "").includes("不是上课时间")) {
            info(`时间戳有效，课程不在签到窗口：${apiData.message}`);
        } else if ((apiData?.message ?? "").includes("参数错误")) {
            info(`${RED}时间戳被拒绝——签到功能异常！${RESET}`);
        }
    } catch (err) {
        check("API 签到请求成功", false, err.message);
    }

    // ─── 结果汇总 ──────────────────────────────────────────────
    const total = passed + failed;
    console.log(`\n${BOLD}${"─".repeat(40)}${RESET}`);
    console.log(`${BOLD}测试结果: ${passed}/${total} 通过${RESET}`);

    if (failed > 0) {
        console.log(`${RED}${failed} 项测试失败${RESET}`);
        // 给出诊断建议
        if (directResult?.ERRCODE === "100") {
            console.log(`\n${YELLOW}诊断建议:${RESET}`);
            console.log("  ERRCODE=100 表示时间戳被 UCAS 拒绝。可能原因：");
            console.log("  1. SIGN_TIMESTAMP_BUFFER_MS 不够大，需要增加缓冲");
            console.log("  2. UCAS 服务器间时钟偏差发生了变化");
            console.log("  3. get_timestamp.do 与 stu_scan_sign.action 的时钟差变大");
        }
    } else {
        console.log(`${GREEN}签到功能正常 ✓${RESET}`);
        console.log(`  (如返回「未在上课时间」而非「参数错误」，即表示时间戳有效)`);
    }
    console.log("");

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(`${RED}测试脚本异常:${RESET}`, err);
    process.exit(2);
});
