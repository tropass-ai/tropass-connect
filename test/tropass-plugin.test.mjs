import {EventEmitter} from "node:events";

import {afterEach, describe, expect, it, vi} from "vitest";

import plugin, {
  buildUpdateCommand,
  checkForUpdate,
  REMIND_DELAY_MS,
  runInstallerUpdate,
} from "../tools/tropass.mjs";
import {formatUsage} from "../tools/commands/usage.mjs";

const UPDATE_CHECK_KEY = Symbol.for("tropass.update.checkStarted");

afterEach(() => {
  delete globalThis[UPDATE_CHECK_KEY];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Tropass plugin", () => {
  it("formats and clamps weekly usage", () => {
    const output = formatUsage({
      used: 1500,
      limit: 1000,
      remaining: 0,
      reset_at: "2026-08-25T09:00:00Z",
    }, "en-US", "UTC");

    expect(output).toContain("████████████████████████ 100%");
    expect(output).toContain("Used       1,500");
    expect(output).toContain("Remaining  0");
    expect(output).toContain("Limit      1,000");
    expect(output).toContain("Resets     Aug 25, 2026, 9:00 AM");
  });

  it("falls back to formatted JSON for an unknown response", () => {
    expect(formatUsage({message: "unknown"})).toBe('{\n  "message": "unknown"\n}');
  });

  it("formats the unlimited response returned by Tropass", () => {
    const output = formatUsage({
      used_tokens: 1152920,
      initial_limit_tokens: null,
      remaining_tokens: null,
      reset_at: "2026-08-19T08:20:19Z",
    }, "en-US", "UTC");

    expect(output).toContain("──────────────────────── ∞");
    expect(output).toContain("Used       1,152,920");
    expect(output).toContain("Remaining  Unlimited");
    expect(output).toContain("Limit      Unlimited");
  });

  it("formats usage before the first request", () => {
    const output = formatUsage({
      used_tokens: 0,
      initial_limit_tokens: null,
      remaining_tokens: null,
      reset_at: null,
    }, "en-US", "UTC");

    expect(output).toContain("Used       0");
    expect(output).toContain("Resets     Not scheduled");
  });

  it("fetches usage and opens a dialog without session APIs", async () => {
    let command;
    const replace = vi.fn((render) => render());
    const toast = vi.fn();
    await plugin.tui({
      command: {register: (commands) => { [command] = commands(); }},
      ui: {
        DialogAlert: vi.fn((props) => props),
        dialog: {clear: vi.fn(), replace},
        toast,
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({used: 1, limit: 4, remaining: 3, reset_at: 0}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await command.onSelect();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(command.slash).toEqual({name: "usage"});
    expect(replace).toHaveReturnedWith(expect.objectContaining({
      title: "Tropass usage",
      message: expect.stringContaining("25%"),
    }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({variant: "info"}));
  });

  it.each([
    ["2.3.0", "2.2.9", true],
    ["2.10.0", "2.9.9", true],
    ["2.2.1", "2.2.1", false],
    ["2.1.9", "2.2.0", false],
    ["2.3.0-beta.1", "2.2.0", false],
  ])("offers only newer stable updates (%s vs %s)", async (candidate, installed, expected) => {
    const {api} = createUpdateApi();
    await checkForUpdate(api, {fetchLatestVersion: async () => candidate, version: installed});
    expect(api.ui.dialog.replace).toHaveBeenCalledTimes(expected ? 1 : 0);
  });

  it("shows native update actions and postpones for 24 hours", async () => {
    const now = 1_000;
    const {api, currentDialog} = createUpdateApi();

    await checkForUpdate(api, {
      fetchLatestVersion: async () => "2.3.0",
      now: () => now,
      version: "2.2.2",
    });

    const dialog = currentDialog();
    expect(dialog.title).toContain("2.2.2 → 2.3.0");
    expect(dialog.options.map(({title}) => title)).toEqual(["Обновить сейчас", "Напомнить завтра"]);

    dialog.onSelect(dialog.options[1]);

    expect(api.kv.set).toHaveBeenCalledWith("tropass.update.remindAfter", now + REMIND_DELAY_MS);
  });

  it("treats closing the update dialog as remind tomorrow", async () => {
    const now = 5_000;
    const {api, closeDialog} = createUpdateApi();

    await checkForUpdate(api, {
      fetchLatestVersion: async () => "3.0.0",
      now: () => now,
      version: "2.2.2",
    });
    closeDialog();

    expect(api.kv.set).toHaveBeenCalledWith("tropass.update.remindAfter", now + REMIND_DELAY_MS);
  });

  it("does not check npm before the reminder expires", async () => {
    const fetchLatestVersion = vi.fn();
    const {api} = createUpdateApi(10_001);

    await checkForUpdate(api, {
      fetchLatestVersion,
      now: () => 10_000,
      version: "2.2.2",
    });

    expect(fetchLatestVersion).not.toHaveBeenCalled();
    expect(api.ui.dialog.replace).not.toHaveBeenCalled();
  });

  it("silently ignores update check errors", async () => {
    const {api} = createUpdateApi();

    await checkForUpdate(api, {
      fetchLatestVersion: async () => { throw new Error("offline"); },
      version: "2.2.2",
    });

    expect(api.ui.dialog.replace).not.toHaveBeenCalled();
    expect(api.ui.toast).not.toHaveBeenCalled();
  });

  it("runs an accepted update and asks to restart OpenCode", async () => {
    const installUpdate = vi.fn().mockResolvedValue(true);
    const {api, currentDialog} = createUpdateApi();

    await checkForUpdate(api, {
      fetchLatestVersion: async () => "2.3.0",
      installUpdate,
      version: "2.2.2",
    });
    currentDialog().onSelect(currentDialog().options[0]);

    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(currentDialog().title).toBe("Tropass обновлён"));
    expect(api.ui.toast).toHaveBeenCalledWith(expect.objectContaining({variant: "info"}));
  });

  it("builds a shell-free update command and passes the token only through env", async () => {
    const updateCommand = buildUpdateCommand({
      packageSpec: "file:/workspace/installer",
      scope: "project",
      configuration: "/workspace/project/opencode.json",
      project: "/workspace/project",
      platform: "win32",
    });
    const child = new EventEmitter();
    const spawnProcess = vi.fn(() => child);

    const update = runInstallerUpdate(spawnProcess, updateCommand);
    child.emit("close", 0);

    await expect(update).resolves.toBe(true);
    expect(updateCommand).toEqual({
      command: "npx.cmd",
      args: [
        "-y",
        "file:/workspace/installer",
        "opencode",
        "--scope",
        "project",
        "--config",
        "/workspace/project/opencode.json",
        "--project",
        "/workspace/project",
        "--yes",
      ],
      cwd: "/workspace/project",
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "npx.cmd",
      updateCommand.args,
      expect.objectContaining({shell: false, env: expect.objectContaining({TROPASS_API_TOKEN: expect.any(String)})}),
    );
    expect(updateCommand.args).not.toContain(spawnProcess.mock.calls[0][2].env.TROPASS_API_TOKEN);
  });
});

function createUpdateApi(remindAfter = 0) {
  let dialog;
  let onClose;
  const replace = vi.fn((render, close) => {
    dialog = render();
    onClose = close;
    return dialog;
  });
  const api = {
    kv: {
      ready: true,
      get: vi.fn(() => remindAfter),
      set: vi.fn(),
    },
    lifecycle: {signal: new globalThis.AbortController().signal},
    ui: {
      DialogAlert: vi.fn((props) => props),
      DialogSelect: vi.fn((props) => props),
      dialog: {
        clear: vi.fn(() => onClose?.()),
        replace,
      },
      toast: vi.fn(),
    },
  };
  return {
    api,
    closeDialog: () => onClose?.(),
    currentDialog: () => dialog,
  };
}
