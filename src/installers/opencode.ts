import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  DEFAULT_TOKEN_HEADER,
  MCP_MODEL_CALL_VERSION_HEADER,
} from "../constants.js";
import type {JsonObject, ModelCallVersion} from "../types.js";
import type {HarnessInstaller} from "./types.js";
import {
  buildBearerToken,
  readJsonFile,
  readObjectProperty,
  stripBearerToken,
  writeJsonFile,
  writeTextFile,
} from "./shared.js";
import {runAgentCli} from "./cli.js";

const PACKAGED_SKILLS_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills",
);
const PACKAGED_TOOLS_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../tools",
);
const SKILL_NAMES = ["tropass-gateway", "agent-response-display"];
const TOOL_FILE_NAME = "wait_for_model_task.ts";
const TOOL_SCRIPT_NAME = "wait_for_model_task.py";
const PLUGIN_FILE_NAME = "tropass.mjs";
const PLUGIN_SUPPORT_FILES = ["commands/usage.mjs", "commands/doctor.mjs"];
const PROVIDER_PLUGIN_FILE_NAME = "tropass-provider.js";
const LEGACY_PLUGIN_FILE_NAME = "tropass-usage.mjs";
const INSTALLER_PACKAGE = readInstallerPackage();

export const opencodeInstaller: HarnessInstaller = {
  installConfig(options, configPath) {
    if (options.scope === "global" && !options.configPath) {
      runAgentCli([
        "mcp",
        "add",
        "tropass",
        "--url",
        options.mcpUrl,
        "--header",
        `${DEFAULT_TOKEN_HEADER}=${buildBearerToken(options.apiToken)}`,
        "--header",
        `${MCP_MODEL_CALL_VERSION_HEADER}=${options.modelCallVersion}`,
      ]);
      writeOpenCodeConfig(configPath, options.mcpUrl, options.apiToken, options.modelCallVersion);
      return;
    }

    writeOpenCodeConfig(configPath, options.mcpUrl, options.apiToken, options.modelCallVersion);
  },

  installProvider(options, configPath) {
    writeOpenCodeProvider(configPath, options.apiToken, options.llmUrl);
  },

  installSkills(skillsPath) {
    return SKILL_NAMES.map((name) => {
      const relativePath = path.join(name, "SKILL.md");
      const skillPath = path.join(skillsPath, relativePath);
      writeTextFile(
        skillPath,
        fs.readFileSync(path.join(PACKAGED_SKILLS_DIRECTORY, relativePath), "utf8"),
      );
      return skillPath;
    });
  },

  installTools(toolsPath, mcpUrl, apiToken, uvxCommand) {
    fs.mkdirSync(toolsPath, { recursive: true });
    const gatewayUrl = buildGatewayUrl(mcpUrl);
    const toolTemplate = fs.readFileSync(path.join(PACKAGED_TOOLS_DIRECTORY, TOOL_FILE_NAME), "utf8");
    const toolPath = path.join(toolsPath, TOOL_FILE_NAME);
    writeTextFile(
      toolPath,
      fillTemplate(toolTemplate, {
        GATEWAY_URL: gatewayUrl,
        GATEWAY_API_TOKEN: stripBearerToken(apiToken),
        UVX_COMMAND: uvxCommand,
      }),
    );
    const scriptPath = path.join(toolsPath, TOOL_SCRIPT_NAME);
    writeTextFile(
      scriptPath,
      fs.readFileSync(path.join(PACKAGED_TOOLS_DIRECTORY, TOOL_SCRIPT_NAME), "utf8"),
    );
    return [toolPath, scriptPath];
  },

  removeTools(toolsPath) {
    return [TOOL_FILE_NAME, TOOL_SCRIPT_NAME]
      .map((name) => path.join(toolsPath, name))
      .filter((filePath) => fs.existsSync(filePath))
      .map((filePath) => {
        fs.rmSync(filePath);
        return filePath;
      });
  },

  installPlugins(configDir, configPath, options) {
    const packagePath = path.join(configDir, "package.json");
    const pluginPackage = readJsonFile(packagePath);
    pluginPackage.dependencies = {
      ...readObjectProperty(pluginPackage, "dependencies"),
      semver: readObjectProperty(INSTALLER_PACKAGE, "dependencies").semver,
    };
    writeJsonFile(packagePath, pluginPackage);

    const pluginPath = path.join(configDir, PLUGIN_FILE_NAME);
    const template = fs.readFileSync(
      path.join(PACKAGED_TOOLS_DIRECTORY, PLUGIN_FILE_NAME),
      "utf8",
    );
    writeTextFile(
      pluginPath,
      fillTemplate(template, {
        USAGE_URL: Buffer.from(`${options.llmUrl.replace(/\/v1$/, "")}/api/rpc/fetch-token-usage/`).toString("base64"),
        API_TOKEN: Buffer.from(stripBearerToken(options.apiToken)).toString("base64"),
        CONFIG_PATH: Buffer.from(configPath).toString("base64"),
        PROJECT_DIR: Buffer.from(options.scope === "project" ? path.dirname(configDir) : "").toString("base64"),
        UVX_COMMAND: Buffer.from(options.uvxCommand ?? "").toString("base64"),
        INSTALLER_VERSION: INSTALLER_PACKAGE.version,
        INSTALL_SCOPE: options.scope,
      }),
    );
    const supportPaths = PLUGIN_SUPPORT_FILES.map((relativePath) => {
      const supportPath = path.join(configDir, relativePath);
      writeTextFile(supportPath, fs.readFileSync(path.join(PACKAGED_TOOLS_DIRECTORY, relativePath), "utf8"));
      return supportPath;
    });
    const providerPluginPath = path.join(configDir, "plugins", PROVIDER_PLUGIN_FILE_NAME);
    writeTextFile(
      providerPluginPath,
      fs.readFileSync(path.join(PACKAGED_TOOLS_DIRECTORY, PROVIDER_PLUGIN_FILE_NAME), "utf8"),
    );
    fs.rmSync(path.join(configDir, LEGACY_PLUGIN_FILE_NAME), { force: true });

    const tuiConfigPath = path.join(configDir, "tui.json");
    const tuiConfig = readJsonFile(tuiConfigPath);
    const plugins = tuiConfig.plugin;
    if (plugins !== undefined && !Array.isArray(plugins)) {
      throw new Error(`Поле конфигурации 'plugin' в ${tuiConfigPath} должно быть массивом.`);
    }
    const tropassPlugins = new Set([`./${PLUGIN_FILE_NAME}`, `./${LEGACY_PLUGIN_FILE_NAME}`]);
    tuiConfig.plugin = [...(plugins ?? []).filter((plugin) => !tropassPlugins.has(String(plugin))), `./${PLUGIN_FILE_NAME}`];
    writeJsonFile(tuiConfigPath, tuiConfig);
    return [pluginPath, providerPluginPath, ...supportPaths];
  },
};

function writeOpenCodeConfig(
  configPath: string,
  mcpUrl: string,
  apiToken: string,
  modelCallVersion: ModelCallVersion,
): void {
  const payload = readJsonFile(configPath);
  payload.mcp = {
    ...readObjectProperty(payload, "mcp"),
    tropass: {
      type: "remote",
      enabled: true,
      timeout: 30 * 60 * 1000,
      url: mcpUrl,
      headers: {
        [DEFAULT_TOKEN_HEADER]: buildBearerToken(apiToken),
        [MCP_MODEL_CALL_VERSION_HEADER]: modelCallVersion,
      },
    },
  };
  writeJsonFile(configPath, payload);
}

function writeOpenCodeProvider(
  configPath: string,
  apiToken: string,
  llmUrl: string,
): void {
  const payload = readJsonFile(configPath);
  if (typeof payload.model === "string" && payload.model.startsWith("tropass/")) {
    delete payload.model;
  }
  const commands = readObjectProperty(payload, "command");
  delete commands.usage;
  if (Object.keys(commands).length) payload.command = commands;
  else delete payload.command;
  payload.provider = {
    ...readObjectProperty(payload, "provider"),
    tropass: {
      npm: "@ai-sdk/openai-compatible",
      name: "Tropass",
      options: {
        baseURL: llmUrl,
        apiKey: stripBearerToken(apiToken),
      },
    },
  };
  writeJsonFile(configPath, payload);
}

function fillTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (filled, [name, value]) => filled.replaceAll(`{{${name}}}`, () => escapeForSourceString(value)),
    template,
  );
}

function escapeForSourceString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function buildGatewayUrl(mcpUrl: string): string {
  return mcpUrl.replace(/\/mcp$/, "").replace(/\/+$/, "");
}

function readInstallerPackage(): JsonObject & {version: string} {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packagePaths = ["../../package.json", "../../../package.json"]
    .map((relativePath) => path.resolve(moduleDirectory, relativePath));
  const packagePath = packagePaths.find((candidate) => fs.existsSync(candidate));
  if (!packagePath) {
    throw new Error("Не найден package.json установщика Tropass.");
  }
  const payload = readJsonFile(packagePath);
  const version = payload.version;
  if (typeof version !== "string") {
    throw new Error(`В ${packagePath} не указана версия установщика Tropass.`);
  }
  return {...payload, version};
}
