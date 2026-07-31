import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { KNOWN_TOOL_NAMES } from "../../src/config.js";

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

test("default panelist and judge can reach the web", async () => {
  const agents = await loadShippedAgents();
  const byName = new Map(agents.map((agent) => [agent.name, agent]));

  for (const name of ["fusion-panelist", "fusion-judge"]) {
    const agent = byName.get(name);
    assert.ok(agent, `missing shipped agent ${name}`);
    assert.ok(
      agent.tools.includes("web_search"),
      `${name} should declare web_search`,
    );
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

test("fusion-panelist-lite has no web access", async () => {
  const agents = await loadShippedAgents();
  const lite = agents.find((agent) => agent.name === "fusion-panelist-lite");

  assert.ok(lite);
  assert.deepEqual(lite.tools, ["read", "grep", "find", "ls"]);
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
