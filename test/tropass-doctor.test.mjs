import {execFile} from "node:child_process";

import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import plugin from "../tools/tropass.mjs";
import {diagnoseTropass} from "../tools/commands/doctor.mjs";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal(),
  execFile: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => callback(null));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({data: [{id: "model"}]}),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Tropass doctor", () => {
  it.each(["command", "keymap"])("runs a local /doctor through %s and displays one report", async (registration) => {
    const api = createApi();
    const clear = vi.fn();
    const replace = vi.fn((render) => render());
    api.ui = {toast: vi.fn(), DialogAlert: (props) => props, dialog: {clear, replace}};
    let commands;
    if (registration === "command") api.command = {register: (getCommands) => { commands = getCommands(); }};
    else api.keymap = {registerLayer: (layer) => { commands = layer.commands; }};

    await plugin.tui(api);
    const doctor = commands.find((command) => command.slash?.name === "doctor" || command.slashName === "doctor");
    await (doctor.onSelect ?? doctor.run)();

    expect(replace).toHaveBeenCalledOnce();
    const report = replace.mock.results[0].value;
    expect(report.title).toBe("Tropass Connect — диагностика");
    expect(report.message).not.toMatch(/WARNING|ERROR/);
    expect(report.message).toContain("OK OpenCode: 1.17.16");
    expect(report.message).toContain("OK Режим вызова моделей: v2");
    expect(report.message).not.toContain("private-token");
    report.onConfirm();
    expect(clear).toHaveBeenCalledOnce();
    expect(api.client.mcp.status).toHaveBeenCalledWith(undefined, {
      throwOnError: true, signal: expect.any(globalThis.AbortSignal),
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledWith("https://llm.example/v1/models", {
      headers: {Authorization: "Bearer private-token"}, signal: expect.any(globalThis.AbortSignal),
    });
    expect(execFile).toHaveBeenCalledWith(expect.any(String), ["--version"], {
      timeout: 3_000, windowsHide: true,
    }, expect.any(Function));
  });

  it("warns about synchronous mode without uvx and missing limits while hiding echoed tokens", async () => {
    const api = createApi();
    api.state.config.mcp.tropass.headers["Tropass-Model-Call-Version"] = "1";
    api.state.provider[0].models.model = {id: "echo-private-token", limit: {context: 0, output: 0}};
    vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => callback(new Error("private-token")));

    const report = await diagnoseTropass(api);

    expect(report).toContain("WARNING uvx: недоступен");
    expect(report).toContain("WARNING Лимиты моделей: отсутствуют у echo-[скрыто]");
    expect(report).toContain("OK Режим вызова моделей: v1");
    expect(report).not.toMatch(/ERROR|private-token/);
  });

  it("rejects async mode without uvx and continues after gateway failures without exposing errors", async () => {
    const api = createApi();
    api.app.version = "1.17.15";
    api.client.mcp.status.mockResolvedValue({data: {tropass: {status: "failed", error: "private-token"}}});
    vi.mocked(execFile).mockImplementation((_command, _args, _options, callback) => callback(new Error("missing uvx")));
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("https://llm.example/?token=private-token"));

    const report = await diagnoseTropass(api);

    expect(report).toContain("ERROR OpenCode: 1.17.15.");
    expect(report).toContain("ERROR MCP-шлюз: не подключён");
    expect(report).toContain("ERROR LLM-шлюз: недоступен");
    expect(report).toContain("ERROR uvx: недоступен");
    expect(report).toContain("ERROR Режим вызова моделей:");
    expect(report).not.toContain("private-token");
  });

  it.each([401, 403, 503])("reports HTTP %s without reading the error response body", async (status) => {
    const body = vi.fn().mockResolvedValue({error: "private-token"});
    vi.mocked(globalThis.fetch).mockResolvedValue({ok: false, status, json: body});

    const report = await diagnoseTropass(createApi());

    expect(report).toContain(`ERROR LLM-шлюз: HTTP ${status}`);
    expect(report).not.toContain("private-token");
    expect(body).not.toHaveBeenCalled();
  });

  it.each([null, {data: []}, {data: [{id: " "}]}, {data: [{id: 1}]}])("rejects invalid catalogs: %j", async (payload) => {
    vi.mocked(globalThis.fetch).mockResolvedValue({ok: true, json: async () => payload});

    expect(await diagnoseTropass(createApi())).toContain("ERROR LLM-шлюз: каталог моделей пуст или имеет неверный формат");
  });

  it("detects a catalog that was not loaded into OpenCode", async () => {
    const api = createApi();
    api.state.provider = [];

    const report = await diagnoseTropass(api);

    expect(report).toContain("OK LLM-шлюз:");
    expect(report).toContain("ERROR Каталог OpenCode: модели Tropass не загружены");
  });

  it.each(["needs_auth", "needs_client_registration", "disabled"])("reports MCP state %s", async (status) => {
    const api = createApi();
    api.client.mcp.status.mockResolvedValue({data: {tropass: {status, error: "private-token"}}});

    const report = await diagnoseTropass(api);

    expect(report).toContain(status === "disabled" ? "WARNING MCP-шлюз: отключён" : "ERROR MCP-шлюз:");
    expect(report).not.toContain("private-token");
  });

  it("does not send requests with invalid URLs or missing credentials", async () => {
    const api = createApi();
    api.state.config.mcp.tropass.url = "file:///tmp/mcp";
    api.state.config.provider.tropass.options.apiKey = "";

    const report = await diagnoseTropass(api);

    expect(report).toContain("ERROR Конфигурация:");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(api.client.mcp.status).not.toHaveBeenCalled();
  });

  it("asks to retry while OpenCode state is loading", async () => {
    const api = createApi();
    api.state.ready = false;

    expect(await diagnoseTropass(api)).toContain("WARNING Конфигурация: данные OpenCode ещё не загружены");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
});

function createApi() {
  return {
    app: {version: "1.17.16"},
    state: {
      ready: true,
      config: {
        mcp: {tropass: {
          type: "remote", url: "https://mcp.example/mcp", enabled: true,
          headers: {Authorization: "Bearer private-token", "Tropass-Model-Call-Version": "2"},
        }},
        provider: {tropass: {options: {baseURL: "https://llm.example/v1/", apiKey: "private-token"}}},
      },
      provider: [{id: "tropass", models: {model: {id: "model", limit: {context: 100_000, output: 8_000}}}}],
    },
    client: {mcp: {status: vi.fn().mockResolvedValue({data: {tropass: {status: "connected"}}})}},
  };
}
