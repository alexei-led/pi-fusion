import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { KNOWN_TOOL_NAMES } from "../../src/config.js";
import {
  COMPOSER_AGENT,
  JUDGE_AGENT,
  PANEL_AGENT,
  PANEL_AGENT_FULL,
  PANEL_AGENT_WEB,
} from "../../src/types.js";

const AGENTS_DIR = "agents";
const KNOWN_TOOLS = new Set(KNOWN_TOOL_NAMES);
const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

interface ShippedAgent {
  file: string;
  name: string;
  tools: string[];
}

test("every shipped agent declares a non-empty tools list", async () => {
  const agents = await loadShippedAgents();
  assert.ok(agents.length >= 4, "expected at least four shipped agents");

  for (const agent of agents) {
    assert.ok(
      agent.tools.length > 0,
      `${agent.file} must declare at least one tool`,
    );
  }
});

test("shipped agents use only known tool names", async () => {
  const agents = await loadShippedAgents();

  for (const agent of agents) {
    for (const tool of agent.tools) {
      // mcp:<name> entries resolve at runtime and cannot be checked statically.
      if (tool.startsWith("mcp:")) continue;
      assert.ok(
        KNOWN_TOOLS.has(tool),
        `${agent.file} declares unknown tool "${tool}"`,
      );
    }
  }
});

test("only fusion-panelist-full may write to the workspace", async () => {
  const agents = await loadShippedAgents();

  for (const agent of agents) {
    const writeTools = agent.tools.filter((tool) => WRITE_TOOLS.has(tool));
    if (agent.name === "fusion-panelist-full") {
      assert.ok(
        writeTools.length > 0,
        "fusion-panelist-full is expected to grant write tools",
      );
      continue;
    }
    assert.deepEqual(
      writeTools,
      [],
      `${agent.file} must stay read-only; the docs guarantee it`,
    );
  }
});

test("default agents declare only Pi core tools", async () => {
  // pi-web-providers is an optional extension. A default agent that declares its
  // tools fails every run for users who do not have it installed - pi-subagents
  // reports "requested unavailable child tools" and marks the task failed.
  const CORE_ONLY = ["read", "grep", "find", "ls"];
  const agents = await loadShippedAgents();
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  for (const name of ["fusion-panelist", "fusion-judge", "fusion-composer"]) {
    const agent = byName.get(name);
    assert.ok(agent, `missing shipped agent ${name}`);
    assert.deepEqual(
      agent.tools,
      CORE_ONLY,
      `${name} must not depend on an optional extension`,
    );
  }
});

test("web tools appear only in explicitly opt-in agents", async () => {
  const agents = await loadShippedAgents();
  const WEB_TOOLS = ["web_search", "web_contents", "web_answer", "web_research"];

  for (const agent of agents) {
    const web = agent.tools.filter((tool) => WEB_TOOLS.includes(tool));
    if (["fusion-panelist-web", "fusion-panelist-full"].includes(agent.name)) {
      assert.ok(web.length > 0, `${agent.name} should declare web tools`);
      continue;
    }
    assert.deepEqual(web, [], `${agent.file} must not require pi-web-providers`);
  }
});

test("no shipped agent enables web_research by default", async () => {
  const agents = await loadShippedAgents();

  for (const agent of agents) {
    if (agent.name === "fusion-panelist-full") continue;
    assert.equal(
      agent.tools.includes("web_research"),
      false,
      `${agent.file} must not enable web_research: a panel would fan it out concurrently`,
    );
  }
});

test("fusion-panelist-web adds web access to the core set", async () => {
  const agents = await loadShippedAgents();
  const web = agents.find((agent) => agent.name === "fusion-panelist-web");

  assert.ok(web);
  assert.deepEqual(web.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "web_search",
    "web_contents",
    "web_answer",
  ]);
});

async function loadShippedAgents(): Promise<ShippedAgent[]> {
  const entries = await readdir(AGENTS_DIR);
  const files = entries.filter((entry) => entry.endsWith(".md")).sort();
  const agents: ShippedAgent[] = [];

  for (const file of files) {
    const raw = await readFile(join(AGENTS_DIR, file), "utf8");
    agents.push({
      file,
      name: readFrontmatterValue(raw, "name", file),
      tools: parseToolList(readFrontmatterValue(raw, "tools", file)),
    });
  }
  return agents;
}

function readFrontmatterValue(raw: string, key: string, file: string): string {
  const match = new RegExp(`^${key}:(.*)$`, "m").exec(readFrontmatter(raw, file));
  assert.ok(match, `${file} frontmatter is missing "${key}:"`);
  return match[1]!.trim();
}

function readFrontmatter(raw: string, file: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  assert.ok(match, `${file} has no YAML frontmatter block`);
  return match[1]!;
}

function parseToolList(value: string): string[] {
  return value
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);
}

test("agent name constants match the shipped agent files", async () => {
  // These constants are what config and run-builder reference; a rename that
  // touches only the markdown would otherwise ship a dangling agent reference.
  const shipped = new Set(
    (await loadShippedAgents()).map((agent) => `pi-fusion.${agent.name}`),
  );

  for (const constant of [
    PANEL_AGENT,
    PANEL_AGENT_WEB,
    PANEL_AGENT_FULL,
    JUDGE_AGENT,
    COMPOSER_AGENT,
  ]) {
    assert.ok(shipped.has(constant), `no shipped agent for ${constant}`);
  }
  assert.equal(shipped.size, 5);
});
