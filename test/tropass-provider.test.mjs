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
        {id: "first-model", modality: "chat", restriction: "none"},
        {id: "GLM-5.2", modality: "vision", restriction: "none"},
        {id: "first-model", modality: "chat", restriction: "none"},
      ]}),
    });

    await loadTropassModels(config, fetchModels);

    expect(fetchModels).toHaveBeenCalledWith("https://llm.example/v1/models", {
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
        {id: "embedding", modality: "embedding", restriction: "none"},
        {id: "first-model", modality: "chat", restriction: "none"},
        {id: "second-model", modality: "chat", restriction: "none"},
      ]}),
    }));

    expect(config.model).toBe("tropass/first-model");
    expect(config.provider.tropass.models).not.toHaveProperty("embedding");
  });

  it.each([
    {modality: "embedding", restriction: "none"},
    {modality: "transcription", restriction: "none"},
    {modality: "tts", restriction: "none"},
    {modality: "unknown", restriction: "none"},
    {restriction: "none"},
    {modality: "chat", restriction: "only_for_admin"},
    {modality: "vision", restriction: "only_for_admin"},
    {modality: "chat", restriction: "unavailable"},
    {modality: "vision", restriction: "unavailable"},
    {modality: "chat", restriction: "unknown"},
    {modality: "chat"},
  ])("excludes unsupported catalog entries: %j", async (metadata) => {
    const config = makeConfig("tropass/GLM-5.2");

    await loadTropassModels(config, async () => ({
      ok: true,
      json: async () => ({data: [
        {id: "GLM-5.2", ...metadata},
        {id: "first-model", modality: "chat", restriction: "none"},
      ]}),
    }));

    expect(config.model).toBe("tropass/first-model");
    expect(config.provider.tropass.models).toEqual({"first-model": {name: "first-model"}});
  });

  it.each([
    ["an HTTP error", async () => ({ok: false})],
    ["a malformed response", async () => ({ok: true, json: async () => ({data: null})})],
    ["an empty catalog", async () => ({ok: true, json: async () => ({data: []})})],
    ["a catalog without chat models", async () => ({
      ok: true,
      json: async () => ({data: [{id: "embedding", modality: "embedding", restriction: "none"}]}),
    })],
    ["a catalog with only restricted chat models", async () => ({
      ok: true,
      json: async () => ({data: [{id: "GLM-5.2", modality: "chat", restriction: "only_for_admin"}]}),
    })],
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
