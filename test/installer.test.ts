import fs from "node:fs";
import {createRequire} from "node:module";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installTropass } from "../src/installer.js";

// Без мока результат зависел бы от того, стоит ли uvx на машине, где идут тесты.
vi.mock("../src/uvx.js", () => ({ findUvx: () => undefined, uvxExecutable: () => "uvx" }));

const TEST_MCP_GATEWAY_URL = "https://апи.тропасс.рф";
const TEST_MCP_URL = `${TEST_MCP_GATEWAY_URL}/mcp`;
const TEST_LLM_GATEWAY_URL = "https://апи.ллм.тропасс.рф/v1";
const TEST_API_TOKEN = "test-token";
const TEST_UVX_COMMAND = "/usr/local/bin/uvx";
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;
const ORIGINAL_OPENCODE_CONFIG = process.env.OPENCODE_CONFIG;
const ORIGINAL_OPENCODE_CONFIG_DIR = process.env.OPENCODE_CONFIG_DIR;

let tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  restoreEnv("XDG_CONFIG_HOME", ORIGINAL_XDG_CONFIG_HOME);
  restoreEnv("OPENCODE_CONFIG", ORIGINAL_OPENCODE_CONFIG);
  restoreEnv("OPENCODE_CONFIG_DIR", ORIGINAL_OPENCODE_CONFIG_DIR);
  for (const tempDir of tempDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("installTropass", () => {
  it("writes OpenCode project config and copies native skills", async () => {
    const projectDir = createTempDir();
    const configPath = path.join(projectDir, "opencode.json");
    const agentsPath = path.join(projectDir, "AGENTS.md");
    const gatewaySkillPath = path.join(projectDir, ".opencode", "skills", "tropass-gateway", "SKILL.md");
    const displaySkillPath = path.join(projectDir, ".opencode", "skills", "agent-response-display", "SKILL.md");
    const toolPath = path.join(projectDir, ".opencode", "tools", "wait_for_model_task.ts");
    const toolScriptPath = path.join(projectDir, ".opencode", "tools", "wait_for_model_task.py");
    const tropassPluginPath = path.join(projectDir, ".opencode", "tropass.mjs");
    const providerPluginPath = path.join(projectDir, ".opencode", "plugins", "tropass-provider.js");
    const legacyPluginPath = path.join(projectDir, ".opencode", "tropass-usage.mjs");
    writeJson(configPath, {
      theme: "system",
      model: "tropass/stale-model",
      command: {
        existing: {
          description: "Existing command",
          template: "Keep me",
        },
      },
      mcp: {
        existing: {
          url: "https://existing.test/mcp",
        },
      },
    });
    writeJson(path.join(projectDir, ".opencode", "tui.json"), {
      plugin: ["existing-plugin", "./tropass-usage.mjs", "./tropass.mjs"],
    });
    writeJson(path.join(projectDir, ".opencode", "package.json"), {
      name: "existing-plugin-dependencies",
      dependencies: {"existing-package": "1.0.0"},
    });
    fs.writeFileSync(legacyPluginPath, "// plugin from an older installer\n");
    fs.writeFileSync(agentsPath, "# Existing agent notes\n");

    const result = installTropass({
      projectDir,
      scope: "project",
      apiToken: TEST_API_TOKEN,
      uvxCommand: TEST_UVX_COMMAND,
    });

    expect(result.client).toBe("opencode");
    expect(result.scope).toBe("project");
    expect(result.configPath).toBe(configPath);
    expect(result.skillPaths).toEqual([gatewaySkillPath, displaySkillPath]);

    expect(result.toolPaths).toEqual([toolPath, toolScriptPath]);
    expect(result.pluginPaths).toEqual([
      tropassPluginPath, providerPluginPath,
      ...["commands/usage.mjs", "commands/doctor.mjs"]
        .map((relativePath) => path.join(projectDir, ".opencode", relativePath)),
    ]);

    const config = readJson(result.configPath);
    expect(config.theme).toBe("system");
    expect(config.model).toBeUndefined();
    expect(config.command.existing).toEqual({
      description: "Existing command",
      template: "Keep me",
    });
    expect(config.command.usage).toBeUndefined();
    expect(config.mcp.existing.url).toBe("https://existing.test/mcp");
    expect(config.mcp.tropass).toEqual({
      type: "remote",
      enabled: true,
      timeout: 1_800_000,
      url: TEST_MCP_URL,
      headers: {
        Authorization: `Bearer ${TEST_API_TOKEN}`,
        "Tropass-Model-Call-Version": "2",
      },
    });
    expect(config.provider.tropass).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "Tropass",
      options: {
        baseURL: TEST_LLM_GATEWAY_URL,
        apiKey: TEST_API_TOKEN,
      },
    });

    expect(fs.readFileSync(agentsPath, "utf8")).toBe("# Existing agent notes\n");
    expect(fs.readFileSync(gatewaySkillPath, "utf8")).toBe(
      fs.readFileSync(path.resolve("skills", "tropass-gateway", "SKILL.md"), "utf8"),
    );
    expect(fs.readFileSync(displaySkillPath, "utf8")).toBe(
      fs.readFileSync(path.resolve("skills", "agent-response-display", "SKILL.md"), "utf8"),
    );

    expect(fs.readFileSync(toolPath, "utf8")).toContain(`GATEWAY_URL = "${TEST_MCP_GATEWAY_URL}"`);
    expect(fs.readFileSync(toolPath, "utf8")).toContain(`GATEWAY_API_TOKEN = "${TEST_API_TOKEN}"`);
    const toolSource = fs.readFileSync(toolPath, "utf8");
    expect(toolSource).not.toContain("path.join(import.meta.dir");
    expect(toolSource).toContain("fileURLToPath(import.meta.url)");
    expect(toolSource).not.toContain("{{");
    expect(toolSource).toContain(`const UVX_COMMAND = "${TEST_UVX_COMMAND}";`);
    const toolScript = fs.readFileSync(toolScriptPath, "utf8");
    expect(toolScript).toContain("wait_for_model_task");
    expect(toolScript).not.toContain(TEST_MCP_GATEWAY_URL);
    expect(toolScript).not.toContain(TEST_API_TOKEN);
    const tropassPlugin = fs.readFileSync(tropassPluginPath, "utf8");
    expect(tropassPlugin).toContain(Buffer.from(TEST_UVX_COMMAND).toString("base64"));
    expect(tropassPlugin).toContain(
      Buffer.from("https://апи.ллм.тропасс.рф/api/rpc/fetch-token-usage/").toString("base64"),
    );
    expect(tropassPlugin).toContain(Buffer.from(TEST_API_TOKEN).toString("base64"));
    expect(tropassPlugin).toContain(Buffer.from(configPath).toString("base64"));
    expect(tropassPlugin).toContain(Buffer.from(projectDir).toString("base64"));
    expect(tropassPlugin).toContain(`const currentVersion = ${JSON.stringify(readJson("package.json").version)};`);
    expect(tropassPlugin).toContain('const installScope = "project";');
    expect(tropassPlugin).not.toContain("{{");
    expect(readJson(path.join(projectDir, ".opencode", "package.json"))).toEqual({
      name: "existing-plugin-dependencies",
      dependencies: {"existing-package": "1.0.0", semver: readJson("package.json").dependencies.semver},
    });
    // OpenCode installs these dependencies at startup; reuse the local package here.
    const dependencyDir = path.join(projectDir, ".opencode", "node_modules");
    fs.mkdirSync(dependencyDir, {recursive: true});
    fs.symlinkSync(path.dirname(createRequire(import.meta.url).resolve("semver/package.json")), path.join(dependencyDir, "semver"), "junction");
    const {default: installedPlugin} = await import(pathToFileURL(tropassPluginPath).href);
    const registerLayer = vi.fn();
    await installedPlugin.tui({keymap: {registerLayer}});
    expect(registerLayer).toHaveBeenCalledWith(expect.objectContaining({
      commands: expect.arrayContaining([
        expect.objectContaining({slashName: "usage"}),
        expect.objectContaining({slashName: "doctor"}),
      ]),
    }));
    expect(fs.readFileSync(providerPluginPath, "utf8")).toContain("loadTropassModels");
    expect(fs.existsSync(legacyPluginPath)).toBe(false);
    expect(readJson(path.join(projectDir, ".opencode", "tui.json")).plugin).toEqual([
      "existing-plugin",
      "./tropass.mjs",
    ]);
  });

  it("defaults to OpenCode global config", () => {
    const homeDir = createTempDir();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.OPENCODE_CONFIG;
    delete process.env.OPENCODE_CONFIG_DIR;
    const configPath = path.join(homeDir, ".config", "opencode", "opencode.jsonc");
    const skillsPath = path.join(homeDir, ".config", "opencode", "skills");
    const displaySkillPath = path.join(skillsPath, "agent-response-display", "SKILL.md");
    const globalToolPath = path.join(homeDir, ".config", "opencode", "tools", "wait_for_model_task.ts");
    const globalTropassPluginPath = path.join(homeDir, ".config", "opencode", "tropass.mjs");
    const globalProviderPluginPath = path.join(homeDir, ".config", "opencode", "plugins", "tropass-provider.js");

    const result = installTropass({
      client: "opencode",
      configPath,
      apiToken: TEST_API_TOKEN,
      uvxCommand: TEST_UVX_COMMAND,
    });

    expect(result.configPath).toBe(configPath);
    expect(result.skillPaths).toEqual([
      path.join(skillsPath, "tropass-gateway", "SKILL.md"),
      displaySkillPath,
    ]);
    expect(fs.readFileSync(displaySkillPath, "utf8")).toContain("name: agent-response-display");
    expect(readJson(result.configPath).mcp.tropass.url).toBe(TEST_MCP_URL);
    expect(readJson(result.configPath).mcp.tropass.timeout).toBe(1_800_000);
    expect(readJson(result.configPath).mcp.tropass.headers.Authorization).toBe(
      `Bearer ${TEST_API_TOKEN}`,
    );
    expect(readJson(result.configPath).mcp.tropass.headers["Tropass-Model-Call-Version"]).toBe("2");
    expect(readJson(result.configPath).provider.tropass.options).toMatchObject({
      baseURL: TEST_LLM_GATEWAY_URL,
      apiKey: TEST_API_TOKEN,
    });
    expect(fs.readFileSync(globalToolPath, "utf8")).toContain(`GATEWAY_URL = "${TEST_MCP_GATEWAY_URL}"`);
    expect(fs.readFileSync(globalToolPath, "utf8")).toContain(`GATEWAY_API_TOKEN = "${TEST_API_TOKEN}"`);
    expect(result.pluginPaths).toEqual([
      globalTropassPluginPath, globalProviderPluginPath,
      ...["commands/usage.mjs", "commands/doctor.mjs"]
        .map((relativePath) => path.join(homeDir, ".config", "opencode", relativePath)),
    ]);
    expect(readJson(path.join(homeDir, ".config", "opencode", "package.json")).dependencies.semver)
      .toBe(readJson("package.json").dependencies.semver);
    expect(readJson(path.join(homeDir, ".config", "opencode", "tui.json")).plugin).toEqual([
      "./tropass.mjs",
    ]);
  });

  it("falls back to synchronous v1 model calls and drops stale tools when uvx is missing", () => {
    const projectDir = createTempDir();
    const configPath = path.join(projectDir, "opencode.json");
    const toolPath = path.join(projectDir, ".opencode", "tools", "wait_for_model_task.ts");
    const toolScriptPath = path.join(projectDir, ".opencode", "tools", "wait_for_model_task.py");
    fs.mkdirSync(path.dirname(toolPath), { recursive: true });
    fs.writeFileSync(toolPath, "// stale tool from a previous install\n");
    fs.writeFileSync(toolScriptPath, "# stale script\n");

    const result = installTropass({
      projectDir,
      scope: "project",
      apiToken: TEST_API_TOKEN,
    });

    expect(result.modelCallVersion).toBe("1");
    expect(result.toolPaths).toEqual([]);
    expect(result.removedToolPaths).toEqual([toolPath, toolScriptPath]);
    expect(fs.existsSync(toolPath)).toBe(false);
    expect(fs.existsSync(toolScriptPath)).toBe(false);
    expect(readJson(configPath).mcp.tropass.headers["Tropass-Model-Call-Version"]).toBe("1");
  });

  it("bakes uvx paths containing $ and backslashes without corrupting the template", () => {
    const projectDir = createTempDir();
    const uvxCommand = "C:\\Users\\d$mikh\\.local\\bin\\uvx.exe";

    installTropass({
      projectDir,
      scope: "project",
      apiToken: "sk-$&-token",
      uvxCommand,
    });

    const toolSource = fs.readFileSync(
      path.join(projectDir, ".opencode", "tools", "wait_for_model_task.ts"),
      "utf8",
    );
    expect(toolSource).toContain(`const UVX_COMMAND = ${JSON.stringify(uvxCommand)};`);
    expect(toolSource).toContain(`const GATEWAY_API_TOKEN = ${JSON.stringify("sk-$&-token")};`);
  });

  it.each(["codex", "claude"])("rejects removed client %s", (client) => {
    expect(() =>
      installTropass({
        client,
        apiToken: TEST_API_TOKEN,
      }),
    ).toThrow("не поддерживается");
  });
});

function createTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tropass-connect-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function writeJson(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function readJson(filePath: string) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
