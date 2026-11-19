/**
 * qingClaw Goal Loop —— 长目标循环（qingClaw 个性化扩展）
 *
 * 设计来自 Learn-OpenClaw 教程第 9 章（参考 OpenAI Codex 的 /goal）：
 * - /goal <目标>       人工入口：设定长期目标，agent 每轮停下时若目标未完成会被自动唤醒继续推进
 * - /goal              查看当前目标状态
 * - /goal stop         停止当前目标
 * - set_goal 工具       agent 入口：agent 可自主设定目标（也让非交互模式可测试）
 * - goal_complete 工具  结束循环的唯一出口：agent 必须在目标真正完成时调用
 *
 * 状态通过 pi.appendEntry 持久化进会话，重启后自动恢复。
 * 防呆：连续自动续跑超过 MAX_NUDGES 轮仍未见 goal_complete，则暂停自动续跑，
 * 避免目标不可达时无限消耗 token。
 *
 * 实现要点（踩坑记录）：
 * - agent_end 事件触发时 runtime 仍视为 processing，此时直接 sendUserMessage 会抛
 *   "Agent is already processing"；而带 deliverAs: "followUp" 排队的消息在 agent 停止后
 *   不会被冲刷（队列没有下一次驱动时机）。
 * - 因此采用轮询方案：agent_end 后延迟轮询 ctx.isIdle()，等 runtime 真正空闲后直接
 *   sendUserMessage（空闲时发送会立即触发新一轮）。
 * - 自动续跑依赖常驻运行时（TUI / RPC 模式）。--print 单发模式处理完即退出，无法续跑。
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

const GOAL_ENTRY = "qingclaw-goal-state";
const MAX_NUDGES = 30;
const WAKE_POLL_INTERVAL_MS = 200;
const WAKE_MAX_TRIES = 150; // 200ms * 150 = 30s 内等不到空闲就放弃本轮唤醒

interface GoalState {
	active: boolean;
	goal: string;
	nudges: number;
	startedAt: number | undefined;
}

const EMPTY_STATE: GoalState = { active: false, goal: "", nudges: 0, startedAt: undefined };

/** 从会话条目里安全还原状态（忽略不合法的历史数据） */
function asGoalState(value: unknown): GoalState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (typeof record.active !== "boolean" || typeof record.goal !== "string") return undefined;
	return {
		active: record.active,
		goal: record.goal,
		nudges: typeof record.nudges === "number" ? record.nudges : 0,
		startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
	};
}

export default function (pi: ExtensionAPI) {
	let state: GoalState = { ...EMPTY_STATE };
	let wakePending = false;

	const save = () => pi.appendEntry(GOAL_ENTRY, { ...state });

	/**
	 * 调度一次唤醒：轮询等 runtime 空闲后发送消息（触发新一轮）。
	 * 空闲时 sendUserMessage 立即触发 turn；等待期间若目标被停止则放弃。
	 */
	const scheduleWake = (ctx: { isIdle: () => boolean }, message: string) => {
		if (wakePending) return;
		wakePending = true;

		let tries = 0;
		const trySend = () => {
			if (!state.active) {
				wakePending = false; // 等待期间目标已被停止/完成
				return;
			}
			let idle = false;
			try {
				idle = ctx.isIdle();
			} catch {
				idle = false;
			}
			if (idle) {
				wakePending = false;
				try {
					pi.sendUserMessage(message);
				} catch {
					// 发送失败（如又变忙）则放弃本轮，下一轮 agent_end 会重新调度
				}
				return;
			}
			if (++tries > WAKE_MAX_TRIES) {
				wakePending = false; // 等不到空闲，放弃；下一轮 agent_end 会重新调度
				return;
			}
			setTimeout(trySend, WAKE_POLL_INTERVAL_MS);
		};
		setTimeout(trySend, WAKE_POLL_INTERVAL_MS);
	};

	// ---- 会话启动：恢复上次的目标状态 ----
	pi.on("session_start", async (_event, ctx) => {
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === GOAL_ENTRY) {
				const restored = asGoalState(entry.data);
				if (restored) state = restored;
			}
		}
		if (state.active && ctx.hasUI) {
			ctx.ui.notify(`qingClaw 目标循环已恢复：${state.goal}`, "info");
		}
	});

	// ---- 人工入口：/goal 命令 ----
	pi.registerCommand("goal", {
		description: "qingClaw 长目标循环：/goal <目标> 设定并开始 | /goal 查看状态 | /goal stop 停止",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();

			if (!input) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						state.active
							? `目标进行中：${state.goal}（已自动续跑 ${state.nudges}/${MAX_NUDGES} 轮）`
							: "当前没有进行中的目标。用 /goal <目标> 设定。",
						"info",
					);
				}
				return;
			}

			if (input === "stop" || input === "off" || input === "停止") {
				state = { ...EMPTY_STATE };
				save();
				if (ctx.hasUI) ctx.ui.notify("目标循环已停止。", "warning");
				return;
			}

			state = { active: true, goal: input, nudges: 0, startedAt: Date.now() };
			save();
			if (ctx.hasUI) ctx.ui.notify(`目标已设定，开始推进：${input}`, "info");

			scheduleWake(
				ctx,
				`[qingClaw] 用户设定了长期目标：${input}\n` +
					"请立即开始朝着这个目标工作，用工具实际执行，不要只给计划。\n" +
					"当目标完全达成时，必须调用 goal_complete 工具结束目标循环。",
			);
		},
	});

	// ---- agent 入口 1：set_goal 工具（agent 可自主设定目标）----
	pi.registerTool({
		name: "set_goal",
		label: "Set Goal",
		description:
			"设定一个长期目标并进入目标循环：每轮结束后若目标未完成，你会被自动唤醒继续推进，直到调用 goal_complete。",
		parameters: Type.Object({
			goal: Type.String({ description: "要达成的长期目标，一句话描述" }),
		}),
		async execute(_toolCallId, params) {
			state = { active: true, goal: params.goal, nudges: 0, startedAt: Date.now() };
			save();
			return {
				content: [
					{
						type: "text",
						text: `目标已设定并激活：${params.goal}\n从现在开始持续推进该目标；完全达成后调用 goal_complete 结束循环。`,
					},
				],
				details: {},
			};
		},
	});

	// ---- agent 入口 2：goal_complete 工具（结束循环的唯一出口）----
	pi.registerTool({
		name: "goal_complete",
		label: "Goal Complete",
		description: "当且仅当长期目标已完全达成时调用。调用后目标循环结束，不再自动唤醒。",
		parameters: Type.Object({
			summary: Type.String({ description: "目标完成情况总结：做了什么、结果如何" }),
		}),
		async execute(_toolCallId, params) {
			const goal = state.goal;
			const nudges = state.nudges;
			const seconds = state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : 0;
			state = { ...EMPTY_STATE };
			wakePending = false;
			save();
			return {
				content: [
					{
						type: "text",
						text: `目标「${goal}」已标记完成（历时 ${seconds} 秒，自动续跑 ${nudges} 轮）。总结：${params.summary}`,
					},
				],
				details: {},
			};
		},
	});

	// ---- 自动续跑：每轮结束若目标仍未完成，等空闲后唤醒 agent 继续 ----
	pi.on("agent_end", async (_event, ctx) => {
		if (!state.active) return; // goal_complete 已把 active 置 false，自然终止
		if (state.nudges >= MAX_NUDGES) return; // 防呆：达到上限，停止自动续跑，等待用户处理

		state = { ...state, nudges: state.nudges + 1 };
		save();
		scheduleWake(
			ctx,
			`[qingClaw goal] 长期目标尚未完成：${state.goal}\n` +
				`请继续推进（第 ${state.nudges}/${MAX_NUDGES} 次自动续跑）。` +
				"如果目标已经完全达成，调用 goal_complete 结束；如果被阻塞无法继续，请明确说明阻塞原因。",
		);
	});
}
