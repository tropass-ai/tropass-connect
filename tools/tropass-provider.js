const providerId = "tropass";
const preferredModel = "GLM-5.2";

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
    if (!Array.isArray(payload?.data)) throw new TypeError("Invalid Tropass model catalog.");

    const modelIds = [...new Set(payload.data.flatMap((model) => {
      if (!["chat", "vision"].includes(model?.modality)
        || model?.restriction !== "none") return [];
      const modelId = typeof model?.id === "string" ? model.id.trim() : "";
      return modelId ? [modelId] : [];
    }))];
    provider.models = Object.fromEntries(modelIds.map((modelId) => [
      modelId,
      {
        name: modelId,
        ...(modelId === preferredModel && {
          modalities: {input: ["text", "image"], output: ["text"]},
        }),
      },
    ]));
    if (!modelIds.length) {
      console.warn("Tropass model discovery returned no models.");
      return;
    }

    config.model = `${providerId}/${modelIds.includes(preferredModel) ? preferredModel : modelIds[0]}`;
  } catch {
    console.warn("Tropass model discovery failed; starting without Tropass models.");
  }
}

export default {
  id: "tropass-provider",
  server: async () => ({config: loadTropassModels}),
};
