import {afterEach, describe, expect, it, vi} from "vitest";

import {loadTropassModels} from "../tools/tropass-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tropass provider plugin", () => {
  it("loads display names and selects the default model", async () => {
    const config = makeConfig("tropass/stale");
    const fetchModels = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({data: [
        {id: "first-model", name: "First Model", restriction: "none", is_default: true},
        {id: "GLM-5.2", name: "GLM 5.2", restriction: "none", is_default: false},
      ]}),
    });

    await loadTropassModels(config, fetchModels);

    expect(fetchModels).toHaveBeenCalledWith("https://llm.example/v1/models", {
      headers: {Authorization: "Bearer token"},
      signal: expect.any(globalThis.AbortSignal),
    });
    expect(config.model).toBe("tropass/first-model");
    expect(config.provider.tropass.models).toEqual({
      "first-model": {name: "First Model"},
      "GLM-5.2": {
        name: "GLM 5.2",
        modalities: {input: ["text", "image"], output: ["text"]},
      },
    });
  });

  it.each([
    ["an HTTP error", async () => ({ok: false})],
    ["a malformed response", async () => ({ok: true, json: async () => ({data: null})})],
    ["a legacy response", async () => ({ok: true, json: async () => ({data: [{id: "legacy-model"}]})})],
    ["a catalog without a default", async () => ({
      ok: true,
      json: async () => ({data: [{id: "model", name: "Model", restriction: "none", is_default: false}]}),
    })],
    ["a catalog with multiple defaults", async () => ({
      ok: true,
      json: async () => ({data: [
        {id: "first", name: "First", restriction: "none", is_default: true},
        {id: "second", name: "Second", restriction: "none", is_default: true},
      ]}),
    })],
    ["an empty catalog", async () => ({ok: true, json: async () => ({data: []})})],
  ])("starts without Tropass models after %s", async (_case, fetchModels) => {
    vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
    const config = makeConfig("tropass/stale");

    await loadTropassModels(config, fetchModels);

    expect(config.model).toBeUndefined();
    expect(config.provider.tropass.models).toEqual({});
  });

  it("preserves another provider's default when discovery fails", async () => {
    vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
    const config = makeConfig("other/model");

    await loadTropassModels(config, async () => { throw new Error("offline"); });

    expect(config.model).toBe("other/model");
    expect(config.provider.tropass.models).toEqual({});
  });
});

function makeConfig(model) {
  return {
    ...(model && {model}),
    provider: {
      tropass: {
        options: {baseURL: "https://llm.example/v1/", apiKey: "token"},
        models: {stale: {name: "stale"}},
      },
    },
  };
}
