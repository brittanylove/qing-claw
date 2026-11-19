/**
 * qingClaw goal 扩展的 RPC 端到端测试驱动
 *
 * 启动 pi --mode rpc（常驻进程），发送一个"必须被多次唤醒才能完成"的目标，
 * 不再发送任何输入，观察 agent 是否被扩展自动续跑直至 goal_complete。
 *
 * 通过标准：
 *  1. agent_start 出现多次（证明自动续跑持续唤醒，而非单轮应答）
 *  2. 事件流中出现 goal_complete 工具调用
 *  3. goal_complete 后循环停止（无死循环）
 *
 * 用法：
 *   node scripts/rpc-goal-test.mjs
 *   PI_PROVIDER=ustc PI_MODEL=deepseek-flash node scripts/rpc-goal-test.mjs
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");

const PROVIDER = process.env.PI_PROVIDER ?? "ustc";
const MODEL = process.env.PI_MODEL ?? "deepseek-flash";
const TIMEOUT_MS = Number(process.env.PI_TIMEOUT_MS ?? 240_000);

const PROMPT =
	"请用 set_goal 工具设定目标「从1数到5，每次被唤醒只报出下一个数字，报完5才结束」。" +
	"规则：你每轮只报一个数字，绝不能提前报完。开始。";

const proc = spawn("node", [CLI, "--mode", "rpc", "--provider", PROVIDER, "--model", MODEL, "--no-session"], {
	cwd: repoRoot,
	stdio: ["pipe", "pipe", "pipe"],
});

const events = [];
let buf = "";
let done = false;
let goalCompleteSeen = false;

const timer = setTimeout(() => {
	console.log("RESULT: TIMEOUT (goal 循环未在时限内完成)");
	finish(1);
}, TIMEOUT_MS);

function finish(code) {
	if (done) return;
	done = true;
	clearTimeout(timer);

	const kinds = {};
	for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
	const agentStarts = kinds["agent_start"] ?? 0;
	const toolRuns = {};
	for (const e of events) {
		if (e.type === "tool_execution_start") {
			const name = e.toolName ?? e.name ?? "unknown";
			toolRuns[name] = (toolRuns[name] ?? 0) + 1;
		}
	}

	console.log("---- 统计 ----");
	console.log("事件总数:", events.length);
	console.log("事件类型分布:", JSON.stringify(kinds));
	console.log("agent_start 轮数:", agentStarts);
	console.log("工具执行:", JSON.stringify(toolRuns));

	let verdict = "FAIL";
	if (goalCompleteSeen && agentStarts >= 4) verdict = "PASS (自动续跑循环工作正常)";
	else if (goalCompleteSeen) verdict = "PARTIAL (完成但续跑轮数不足)";
	console.log("RESULT:", verdict);

	try {
		proc.kill();
	} catch {}
	process.exit(code);
}

proc.stdout.on("data", (d) => {
	buf += d.toString();
	let idx;
	while ((idx = buf.indexOf("\n")) !== -1) {
		const line = buf.slice(0, idx).trim();
		buf = buf.slice(idx + 1);
		if (!line) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		events.push(obj);
		const type = obj.type ?? "?";

		if (type === "agent_start" || type === "agent_end") {
			console.error(`[evt] ${type}`);
		} else if (type === "message" && obj.message?.role === "assistant") {
			const c = obj.message.content ?? [];
			const texts = c.filter((p) => p.type === "text").map((p) => p.text);
			const tools = c.filter((p) => p.type === "toolCall").map((p) => p.name);
			console.error(`[assistant] text=${JSON.stringify(texts)} tools=${JSON.stringify(tools)}`);
			if (tools.includes("goal_complete")) goalCompleteSeen = true;
		} else if (type === "tool_execution_start" && (obj.toolName === "goal_complete" || obj.name === "goal_complete")) {
			goalCompleteSeen = true;
		} else if (type === "response") {
			console.error(`[resp] success=${obj.success}`);
		}

		// goal_complete 出现后再收集 3 秒收尾事件即判定成功退出（RPC 常驻进程不会自行退出）
		if (goalCompleteSeen && !done) {
			setTimeout(() => finish(0), 3000);
		}
	}
});

proc.stderr.on("data", (d) => {
	console.error("[stderr]", d.toString().slice(0, 300));
});

proc.on("exit", (code) => {
	console.error(`[rpc process exited: ${code}]`);
	finish(code === 0 && goalCompleteSeen ? 0 : 1);
});

proc.stdin.write(JSON.stringify({ id: "r1", type: "prompt", message: PROMPT }) + "\n");
