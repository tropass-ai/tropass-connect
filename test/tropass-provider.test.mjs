import {afterEach, describe, expect, it, vi} from "vitest";

import {loadTropassModels} from "../tools/tropass-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tropass provider plugin", () => {
  it("loads catalog metadata, keeps the first duplicate and prefers GLM-5.2", async () => {
    const config = makeConfig("tropass/stale");
    const fetchModels = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({data: [
        {id: "first-model", name: "First model", context_length: 131_072, modality: "chat", restriction: "none"},
        {id: "GLM-5.2", name: "GLM 5.2", context_length: 200_000, modality: "vision", restriction: "none"},
        {id: "first-model", name: "Duplicate", context_length: 8_192, modality: "vision", restriction: "none"},
      ]}),
    });

    await loadTropassModels(config, fetchModels);

    expect(fetchModels).toHaveBeenCalledWith("https://llm.example/v1/models", {
      headers: {Authorization: "Bearer token"},
      signal: expect.any(globalThis.AbortSignal),
    });
    expect(config.model).toBe("tropass/GLM-5.2");
    expect(config.provider.tropass.models).toEqual({
      "first-model": {
        name: "First model",
        modalities: {input: ["text"], output: ["text"]},
        limit: {context: 131_072},
      },
      "GLM-5.2": {
        name: "GLM 5.2",
        modalities: {input: ["text", "image"], output: ["text"]},
        limit: {context: 200_000},
      },
    });
  });

  it.each(["chat", "vision"])("derives %s modalities from the catalog for every model", async (modality) => {
    const config = makeConfig();

    await loadTropassModels(config, async () => ({
      ok: true,
      json: async () => ({data: [
        {id: "GLM-5.2", modality, restriction: "none"},
        {id: "another-model", modality, restriction: "none"},
      ]}),
    }));

    for (const model of Object.values(config.provider.tropass.models)) {
      expect(model.modalities).toEqual({
        input: modality === "vision" ? ["text", "image"] : ["text"],
        output: ["text"],
      });
    }
  });

  it.each([undefined, null, 0, -1, 1.5, "131072", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "omits missing or invalid context limits: %j", async (context_length) => {
      const config = makeConfig();

      await loadTropassModels(config, async () => ({
        ok: true,
        json: async () => ({data: [{id: "model", context_length, modality: "chat", restriction: "none"}]}),
      }));

      expect(config.model).toBe("tropass/model");
      expect(config.provider.tropass.models.model).not.toHaveProperty("limit");
    },
  );

  it.each([undefined, null, "", "   ", 123])("falls back to the model ID for missing or invalid names: %j", async (name) => {
    const config = makeConfig();

    await loadTropassModels(config, async () => ({
      ok: true,
      json: async () => ({data: [{id: "model", name, modality: "chat", restriction: "none"}]}),
    }));

    expect(config.provider.tropass.models.model.name).toBe("model");
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
    expect(config.provider.tropass.models).toEqual({"first-model": {
      name: "first-model",
      modalities: {input: ["text"], output: ["text"]},
    }});
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
