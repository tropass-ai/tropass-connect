import {spawn} from "node:child_process";
import process from "node:process";

import semver from "semver";

import {createDoctorCommand} from "./commands/doctor.mjs";
import {createUsageCommand} from "./commands/usage.mjs";

const decode = (value) => Buffer.from(value, "base64").toString();
const usageUrl = decode("{{USAGE_URL}}");
const apiToken = decode("{{API_TOKEN}}");
const configPath = decode("{{CONFIG_PATH}}");
const projectDir = decode("{{PROJECT_DIR}}");
const uvxCommand = decode("{{UVX_COMMAND}}");
const currentVersion = "{{INSTALLER_VERSION}}";
const installScope = "{{INSTALL_SCOPE}}";
const installerPackage = "@tropass/connect@latest";
const registryUrl = "https://registry.npmjs.org/@tropass%2Fconnect/latest";
const remindAfterKey = "tropass.update.remindAfter";
const updateCheckKey = Symbol.for("tropass.update.checkStarted");

export const REMIND_DELAY_MS = 24 * 60 * 60 * 1000;

export function buildUpdateCommand({
  packageSpec = installerPackage,
  scope = installScope,
  configuration = configPath,
  project = projectDir,
  platform = process.platform,
} = {}) {
  return {
    command: platform === "win32" ? "npx.cmd" : "npx",
    args: [
      "-y",
      packageSpec,
      "opencode",
      "--scope",
      scope,
      "--config",
      configuration,
      ...(project ? ["--project", project] : []),
      "--yes",
    ],
    cwd: project || undefined,
  };
}

export function runInstallerUpdate(spawnProcess = spawn, updateCommand = buildUpdateCommand()) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(updateCommand.command, updateCommand.args, {
      cwd: updateCommand.cwd,
      env: {...process.env, TROPASS_API_TOKEN: apiToken},
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode === 0));
  });
}

export async function checkForUpdate(api, {
  fetchLatestVersion = retrieveLatestVersion,
  installUpdate = runInstallerUpdate,
  now = Date.now,
  version = currentVersion,
} = {}) {
  if (globalThis[updateCheckKey]) return;
  globalThis[updateCheckKey] = true;

  if (!await waitForKv(api)) return;
  const remindAfter = Number(api.kv.get(remindAfterKey, 0));
  if (Number.isFinite(remindAfter) && remindAfter > now()) return;

  try {
    const latestVersion = await fetchLatestVersion();
    if (!semver.satisfies(latestVersion, `>${version}`)) return;
    showUpdateDialog(api, version, latestVersion, installUpdate, now);
  } catch {}
}

async function waitForKv(api) {
  while (!api.kv.ready) {
    if (api.lifecycle?.signal.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

async function retrieveLatestVersion() {
  const response = await fetch(registryUrl, {signal: AbortSignal.timeout(3_000)});
  if (!response.ok) return undefined;
  const payload = await response.json();
  return typeof payload?.version === "string" ? payload.version : undefined;
}

function showUpdateDialog(api, installedVersion, latestVersion, installUpdate, now) {
  let handled = false;
  const remindTomorrow = () => api.kv.set(remindAfterKey, now() + REMIND_DELAY_MS);

  api.ui.dialog.replace(
    () => api.ui.DialogSelect({
      title: `Обновление Tropass ${installedVersion} → ${latestVersion}`,
      options: [
        {
          title: "Обновить сейчас",
          value: "update",
          description: "Обновить конфигурацию и плагины Tropass",
        },
        {
          title: "Напомнить завтра",
          value: "later",
          description: "Скрыть предложение на 24 часа",
        },
      ],
      current: "update",
      flat: true,
      skipFilter: true,
      onSelect(option) {
        handled = true;
        api.ui.dialog.clear();
        if (option.value === "later") {
          remindTomorrow();
          return;
        }
        void installWithFeedback(api, installUpdate);
      },
    }),
    () => {
      if (!handled) remindTomorrow();
    },
  );
}

async function installWithFeedback(api, installUpdate) {
  api.ui.toast({
    variant: "info",
    message: "Обновляем Tropass…",
    duration: 30_000,
  });

  try {
    if (!await installUpdate()) throw new Error("Установщик завершился с ошибкой.");
    api.ui.dialog.replace(() => api.ui.DialogAlert({
      title: "Tropass обновлён",
      message: "Перезапустите OpenCode, чтобы применить обновление.",
      onConfirm: () => api.ui.dialog.clear(),
    }));
  } catch (error) {
    api.ui.toast({
      variant: "error",
      message: error instanceof Error ? error.message : "Не удалось обновить Tropass.",
      duration: 10_000,
    });
  }
}

function registerCommands(api) {
  const commands = [
    createUsageCommand(api, {usageUrl, apiToken}),
    createDoctorCommand(api, {uvxCommand, apiToken}),
  ];

  if (api.command) {
    api.command.register(() => commands.map(({name, title, run}) => ({
      title,
      value: `tropass.${name}`,
      category: "Tropass",
      slash: {name},
      onSelect: run,
    })));
    return;
  }

  api.keymap.registerLayer({
    mode: "base",
    commands: commands.map(({name, title, run}) => ({
      name: `tropass.${name}`,
      title,
      category: "Tropass",
      namespace: "palette",
      slashName: name,
      run,
    })),
  });
}

export default {
  id: "tropass",
  async tui(api) {
    registerCommands(api);
    if (api.kv && api.ui.DialogSelect) void checkForUpdate(api);
  },
};
