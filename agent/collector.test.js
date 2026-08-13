import { describe, expect, test } from "bun:test";
import { debounceDelay, freshSession, MAX_SESSIONS, parseLine, publicSession, queueSession, recoverSessions, skillReads } from "./collector.js";

describe("collector", () => {
  test("keeps only aggregate session metadata and latest cumulative usage", () => {
    const session = freshSession();
    parseLine(session, JSON.stringify({ type: "session_meta", timestamp: "2026-08-13T10:00:00Z", payload: { id: "abc", cwd: "/Users/me/secret-project", cli_version: "0.147.0" } }));
    parseLine(session, JSON.stringify({ type: "turn_context", timestamp: "2026-08-13T10:01:00Z", payload: { turn_id: "one", model: "gpt-5.6-sol", effort: "high" } }));
    parseLine(session, JSON.stringify({ type: "response_item", timestamp: "2026-08-13T10:02:00Z", payload: { type: "function_call", name: "exec_command", arguments: "SECRET" } }));
    parseLine(session, JSON.stringify({ type: "response_item", timestamp: "2026-08-13T10:02:30Z", payload: { type: "custom_tool_call", name: "exec", input: 'const r = await tools.exec_command({"cmd":"rtk cat /Users/me/.agents/skills/frontend-design/SKILL.md"});' } }));
    parseLine(session, JSON.stringify({ type: "event_msg", timestamp: "2026-08-13T10:03:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } }));
    parseLine(session, JSON.stringify({ type: "event_msg", timestamp: "2026-08-13T10:03:00Z", payload: { type: "mcp_tool_call_end", result: { Err: {} } } }));
    expect(session).toMatchObject({ id: "abc", cwdLabel: "secret-project", repo: "secret-project", model: "gpt-5.6-sol", turnCount: 1, toolCount: 2, tools: { exec_command: 1, exec: 1 }, skills: { "frontend-design": 1 }, totalTokens: 120, durationMs: 180000 });
    const state = { synced: {}, pending: {} };
    expect(queueSession(state, session)).toBe(true);
    expect(queueSession(state, session)).toBe(false);
    expect(publicSession(session)).toMatchObject({ id: "abc", errorCount: 1 });
    expect(JSON.stringify(state.pending)).not.toMatch(/SECRET|\/Users\/me\/|_turns|_subagents|SKILL\.md/);
    state.synced.abc = state.pending.abc.fingerprint;
    delete state.pending.abc;
    expect(queueSession(state, session)).toBe(false);
    session.totalTokens++;
    expect(queueSession(state, session)).toBe(true);
  });

  test("debounces for three minutes and allows one bounded recovery request", () => {
    expect(debounceDelay(1_000, 2_000)).toBe(179_000);
    expect(debounceDelay(1_000, 200_000)).toBe(0);
    expect(MAX_SESSIONS).toBe(1000);
  });

  test("counts only direct structural skill file reads", () => {
    expect(skillReads('rtk cat /opt/skills/ponytail/SKILL.md && rtk sed -n "1,200p" /opt/skills/cloudflare/SKILL.md')).toEqual(["ponytail", "cloudflare"]);
    expect(skillReads('rtk rg "SKILL.md" /opt/skills')).toEqual([]);
  });

  test("reparses a collapsed historical subagent once and keeps its first session identity", () => {
    const parentId = "019fea4f-89ba-7c71-b93d-53002d3bf32d";
    const childId = "019feb8f-207c-77a1-a251-2cf9a0c5ddbd";
    const parent = { ...freshSession(), id: parentId, startedAt: "2026-01-01T00:00:00Z" };
    const childPath = `/tmp/rollout-2026-01-01T00-00-00-${childId}.jsonl`;
    const state = { files: { [childPath]: { offset: 100, session: parent } }, synced: { [parentId]: "already-synced" }, pending: {} };

    expect(recoverSessions(state)).toBe(1);
    expect(state.files[childPath]).toMatchObject({ offset: 0, session: { id: null } });
    parseLine(state.files[childPath].session, JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T01:00:00Z", payload: { id: childId, thread_source: "subagent" } }));
    parseLine(state.files[childPath].session, JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: parentId, source: "vscode" } }));
    expect(state.files[childPath].session).toMatchObject({ id: childId, source: "subagent" });
    expect(queueSession(state, state.files[childPath].session)).toBe(true);
    state.synced[childId] = state.pending[childId].fingerprint;
    delete state.pending[childId];
    expect(recoverSessions(state)).toBe(0);
  });

  test("reparses pre-skill state once", () => {
    const id = "019fea4f-89ba-7c71-b93d-53002d3bf32d";
    const legacy = { ...freshSession(), id, startedAt: "2026-01-01T00:00:00Z" };
    delete legacy.skills;
    const path = `/tmp/rollout-2026-01-01T00-00-00-${id}.jsonl`;
    const state = { files: { [path]: { offset: 100, session: legacy } }, synced: { [id]: "already-synced" }, pending: {} };

    expect(recoverSessions(state)).toBe(1);
    expect(state.files[path]).toMatchObject({ offset: 0, session: { id: null, skills: {} } });
  });
});
