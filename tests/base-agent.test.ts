import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { BaseAgent } from "../src/agents/base-agent.ts";
import type { AgentReply, AgentRuntime, SessionRequest } from "../src/agents/agent-runtime.ts";
import type { LlmSlot } from "../src/orchestrator/llm-config.ts";

/** 记录调用顺序的 mock AgentRuntime */
class MockRuntime implements AgentRuntime {
  callOrder: string[] = [];
  disposed = 0;
  resolveModel(_slot: LlmSlot): Model<any> {
    return { id: "mock", name: "mock", provider: "deepseek" } as Model<any>;
  }
  resolveApiKey(_slot: LlmSlot): string {
    return "mock-key";
  }
  async createSession(req: SessionRequest): Promise<AgentSession> {
    this.callOrder.push("createSession");
    this.lastReq = req;
    return {
      dispose: () => {
        this.disposed++;
        this.callOrder.push("dispose");
      },
      prompt: async () => {
        this.callOrder.push("prompt");
      },
    } as unknown as AgentSession;
  }
  async driveToReply(
    session: AgentSession,
    prompt: string,
  ): Promise<AgentReply> {
    this.callOrder.push(`driveToReply:${prompt}`);
    return { text: '```json\n{"step":1}\n```', stopReason: "stop" };
  }
  lastReq?: SessionRequest;
}

/** 测试用子代理：input → output 透传 */
class TestAgent extends BaseAgent<{ v: number }, { step: number }> {
  protected getSlot(): LlmSlot {
    return "planner";
  }
  protected buildSystemPrompt(input: { v: number }): string {
    return `sys-${input.v}`;
  }
  protected buildUserPrompt(input: { v: number }): string {
    return `user-${input.v}`;
  }
  protected buildTools(): never[] {
    return [];
  }
  protected extractOutput(reply: AgentReply): { step: number } {
    return JSON.parse(reply.text.split("```json\n")[1].split("```")[0]);
  }
}

test("BaseAgent.run: createSession → driveToReply → extractOutput 顺序正确", async () => {
  const runtime = new MockRuntime();
  const agent = new TestAgent(runtime, { cwd: "/p", agentDir: "/cfg" });
  const out = await agent.run({ v: 7 });
  assert.deepEqual(out, { step: 1 });
  assert.deepEqual(runtime.callOrder, [
    "createSession",
    "driveToReply:user-7",
    "dispose",
  ]);
});

test("BaseAgent.run: buildSessionRequest 注入 inMemory + noTools:all + forSubagent prompt", async () => {
  const runtime = new MockRuntime();
  const agent = new TestAgent(runtime, { cwd: "/p", agentDir: "/cfg" });
  await agent.run({ v: 3 });
  const req = runtime.lastReq!;
  assert.equal(req.cwd, "/p");
  assert.equal(req.agentDir, "/cfg");
  assert.equal(req.noTools, "all");
  assert.equal(req.model?.provider, "deepseek");
  assert.equal(req.runtimeApiKey?.apiKey, "mock-key");
});

test("BaseAgent.run: session 创建失败时不调用 dispose", async () => {
  const runtime = new MockRuntime();
  runtime.createSession = async () => {
    throw new Error("create failed");
  };
  const agent = new TestAgent(runtime, { cwd: "/p", agentDir: "/cfg" });
  await assert.rejects(agent.run({ v: 1 }), /create failed/);
  assert.equal(runtime.disposed, 0);
});

test("BaseAgent.run: driveToReply 抛错时 finally 仍 dispose 会话", async () => {
  const runtime = new MockRuntime();
  runtime.driveToReply = async () => {
    throw new Error("prompt failed");
  };
  const agent = new TestAgent(runtime, { cwd: "/p", agentDir: "/cfg" });
  await assert.rejects(agent.run({ v: 1 }), /prompt failed/);
  assert.equal(runtime.disposed, 1);
});