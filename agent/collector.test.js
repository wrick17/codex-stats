import { describe, expect, test } from "bun:test";
import { freshSession, parseLine } from "./collector.js";

describe("collector", () => {
  test("keeps only aggregate session metadata and latest cumulative usage", () => {
    const session = freshSession();
    parseLine(session, JSON.stringify({ type: "session_meta", timestamp: "2026-08-13T10:00:00Z", payload: { id: "abc", cwd: "/Users/me/secret-project", cli_version: "0.147.0" } }));
    parseLine(session, JSON.stringify({ type: "turn_context", timestamp: "2026-08-13T10:01:00Z", payload: { turn_id: "one", model: "gpt-5.6-sol", effort: "high" } }));
    parseLine(session, JSON.stringify({ type: "response_item", timestamp: "2026-08-13T10:02:00Z", payload: { type: "function_call", name: "exec_command", arguments: "SECRET" } }));
    parseLine(session, JSON.stringify({ type: "event_msg", timestamp: "2026-08-13T10:03:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } }));
    expect(session).toMatchObject({ id: "abc", cwdLabel: "secret-project", repo: "secret-project", model: "gpt-5.6-sol", turnCount: 1, toolCount: 1, tools: { exec_command: 1 }, totalTokens: 120, durationMs: 180000 });
    expect(JSON.stringify(session)).not.toContain("SECRET");
    expect(JSON.stringify(session)).not.toContain("/Users/me/");
  });
});
