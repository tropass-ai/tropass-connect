const providerId = "tropass";
const imageInputModel = "GLM-5.2";
const availableRestriction = "none";
const invalidCatalogMessage = "Invalid Tropass model catalog.";

export async function loadTropassModels(config, fetchModels = fetch) {
  if (typeof config.model === "string" && config.model.startsWith(`${providerId}/`)) {
    delete config.model;
  }

  const provider = config.provider?.[providerId];
  if (!provider || typeof provider !== "object") return;
  provider.models = {};

  const baseURL = provider.options?.baseURL;
  const apiKey = provider.options?.apiKey;
  if (typeof baseURL !== "string" || typeof apiKey !== "string" || !baseURL || !apiKey) {
    console.warn("Tropass model discovery skipped: provider settings are incomplete.");
    return;
  }

  try {
    const response = await fetchModels(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: {Authorization: apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) throw new Error("Tropass model discovery failed.");

    const payload = await response.json();
    if (!Array.isArray(payload?.data)) throw new TypeError(invalidCatalogMessage);

    if (!payload.data.length) {
      console.warn("Tropass model discovery returned no models.");
      return;
    }

    const models = payload.data.map((model) => {
      const modelId = typeof model?.id === "string" ? model.id.trim() : "";
      const modelName = typeof model?.name === "string" ? model.name.trim() : "";
      if (!modelId || !modelName || model?.restriction !== availableRestriction || typeof model?.is_default !== "boolean") {
        throw new TypeError(invalidCatalogMessage);
      }
      return {id: modelId, name: modelName, isDefault: model.is_default};
    });
    const defaultModels = models.filter((model) => model.isDefault);
    if (defaultModels.length !== 1 || new Set(models.map((model) => model.id)).size !== models.length) {
      throw new TypeError(invalidCatalogMessage);
    }

    provider.models = Object.fromEntries(models.map((model) => [
      model.id,
      {
        name: model.name,
        ...(model.id === imageInputModel && {
          modalities: {input: ["text", "image"], output: ["text"]},
        }),
      },
    ]));
    config.model = `${providerId}/${defaultModels[0].id}`;
  } catch {
    console.warn("Tropass model discovery failed; starting without Tropass models.");
  }
}

export default {
  id: "tropass-provider",
  server: async () => ({config: loadTropassModels}),
};
