import {afterEach, describe, expect, it, vi} from "vitest";

import {loadTropassModels} from "../tools/tropass-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tropass provider plugin", () => {
  it("loads the live catalog and prefers GLM-5.2", async () => {
    const config = makeConfig("tropass/stale");
    const fetchModels = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({data: [
        {id: "first-model", upstream_type: "inference", modality: "chat"},
        {id: "GLM-5.2", upstream_type: "inference", modality: "chat"},
        {id: "first-model", upstream_type: "inference", modality: "chat"},
      ]}),
    });

    await loadTropassModels(config, fetchModels);

    expect(fetchModels).toHaveBeenCalledWith("https://llm.example/v1/models?upstream_type=inference&modality=chat", {
      headers: {Authorization: "Bearer token"},
      signal: expect.any(globalThis.AbortSignal),
    });
    expect(config.model).toBe("tropass/GLM-5.2");
    expect(config.provider.tropass.models).toEqual({
      "first-model": {name: "first-model"},
      "GLM-5.2": {
        name: "GLM-5.2",
        modalities: {input: ["text", "image"], output: ["text"]},
      },
    });
  });

  it("uses the first returned model when GLM-5.2 is unavailable", async () => {
    const config = makeConfig();

    await loadTropassModels(config, async () => ({
      ok: true,
      json: async () => ({data: [
        {id: "first-model", upstream_type: "inference", modality: "chat"},
        {id: "second-model", upstream_type: "inference", modality: "chat"},
      ]}),
    }));

    expect(config.model).toBe("tropass/first-model");
  });

  it.each([
    ["an HTTP error", async () => ({ok: false})],
    ["a malformed response", async () => ({ok: true, json: async () => ({data: null})})],
    ["an empty catalog", async () => ({ok: true, json: async () => ({data: []})})],
  ])("starts without Tropass models after %s", async (_case, fetchModels) => {
    vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
    const config = makeConfig("tropass/stale");

    await loadTropassModels(config, fetchModels);

    expect(config.model).toBeUndefined();
    expect(config.provider.tropass.models).toEqual({});
  });

  it("excludes ML and non-chat models when a gateway ignores catalog filters", async () => {
    vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
    const config = makeConfig("tropass/stale");

    await loadTropassModels(config, async () => ({
      ok: true,
      json: async () => ({data: [
        {id: "ml-translator", upstream_type: "ml", modality: "chat"},
        {id: "embedding", upstream_type: "inference", modality: "embedding"},
        {id: "chat", upstream_type: "inference", modality: "chat"},
      ]}),
    }));

    expect(config.model).toBe("tropass/chat");
    expect(config.provider.tropass.models).toEqual({chat: {name: "chat"}});
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
