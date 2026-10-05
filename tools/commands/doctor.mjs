import {execFile} from "node:child_process";
import process from "node:process";

import semver from "semver";

export async function diagnoseTropass(api, {uvxCommand = "", apiToken = ""} = {}) {
  const version = api.app?.version;
  const supported = semver.satisfies(version, ">=1.17.16");
  const lines = [supported
    ? `OK OpenCode: ${version}`
    : `ERROR OpenCode: ${semver.valid(version) ?? "версия не определена"}. Обновите до стабильной версии 1.17.16 или новее.`];
  if (!api.state?.ready) {
    return [...lines, "WARNING Конфигурация: данные OpenCode ещё не загружены. Повторите /doctor после загрузки."].join("\n\n");
  }

  const mcp = api.state.config?.mcp?.tropass;
  const provider = api.state.config?.provider?.tropass;
  const headers = Object.fromEntries(Object.entries(mcp?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  const mcpToken = readToken(headers.authorization);
  const llmToken = readToken(provider?.options?.apiKey);
  const configured = mcp?.type === "remote" && validHttpUrl(mcp.url)
    && validHttpUrl(provider?.options?.baseURL) && mcpToken && llmToken;
  lines.push(configured
    ? "OK Конфигурация: MCP, LLM и их API-токены настроены. Доступ проверяется ниже."
    : "ERROR Конфигурация: проверьте URL и API-токены mcp.tropass и provider.tropass. Повторите установку Tropass Connect.");

  const [mcpStatus, llmStatus, hasUvx] = await Promise.all([
    checkMcp(api, mcp, mcpToken),
    checkLlm(provider?.options?.baseURL, llmToken),
    checkUvx(uvxCommand || (process.platform === "win32" ? "uvx.exe" : "uvx")).catch(() => false),
  ]);
  lines.push(mcpStatus, llmStatus);

  const models = Object.values(api.state.provider?.find((item) => item.id === "tropass")?.models ?? {});
  if (!models.length) {
    lines.push("ERROR Каталог OpenCode: модели Tropass не загружены. Проверьте LLM-шлюз и перезапустите OpenCode.");
  } else {
    const missingLimits = models.filter((model) => ![model.limit?.context, model.limit?.output]
      .every((limit) => Number.isFinite(limit) && limit > 0));
    lines.push(missingLimits.length
      ? `WARNING Лимиты моделей: отсутствуют у ${missingLimits.slice(0, 3).map((model) => model.id).join(", ")}${missingLimits.length > 3 ? ` и ещё ${missingLimits.length - 3}` : ""}. Проверьте лимиты контекста и ответа в настройках моделей Tropass.`
      : `OK Каталог OpenCode: ${models.length} моделей, лимиты контекста и ответа заданы.`);
  }

  const mode = headers["tropass-model-call-version"];
  lines.push(hasUvx ? "OK uvx: доступен." : `${mode === "1" ? "WARNING" : "ERROR"} uvx: недоступен. Установите uv и повторите установку Tropass Connect.`);
  lines.push(mode === "1"
    ? "OK Режим вызова моделей: v1, синхронный."
    : mode === "2" && hasUvx
      ? "OK Режим вызова моделей: v2, асинхронный."
      : "ERROR Режим вызова моделей: для v2 нужен uvx; допустимые режимы — v1 и v2. Повторите установку Tropass Connect.");

  // Never display credentials, including ones echoed in model identifiers.
  return [apiToken, mcpToken, llmToken].filter(Boolean)
    .reduce((message, token) => message.replaceAll(token, "[скрыто]"), lines.join("\n\n"));
}

function readToken(value) {
  return typeof value === "string" ? value.replace(/^Bearer\s+/i, "").trim() : "";
}

function validHttpUrl(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function checkUvx(command) {
  return new Promise((resolve) => {
    execFile(command, ["--version"], {timeout: 3_000, windowsHide: true}, (error) => resolve(!error));
  });
}

async function checkMcp(api, config, token) {
  if (config?.type !== "remote" || !validHttpUrl(config.url) || !token) {
    return "ERROR MCP-шлюз: проверьте URL и API-токен в mcp.tropass.";
  }
  if (config.enabled === false) return "WARNING MCP-шлюз: отключён. Включите mcp.tropass.enabled.";
  try {
    const result = await api.client.mcp.status(undefined, {signal: AbortSignal.timeout(3_000), throwOnError: true});
    switch (result.data?.tropass?.status) {
      case "connected": return "OK MCP-шлюз: подключён, авторизация выполнена.";
      case "disabled": return "WARNING MCP-шлюз: отключён. Включите mcp.tropass.enabled.";
      case "needs_auth": return "ERROR MCP-шлюз: требуется авторизация. Проверьте API-токен Tropass.";
      default: return "ERROR MCP-шлюз: не подключён. Проверьте сеть, URL и API-токен; перезапустите OpenCode.";
    }
  } catch {
    return "ERROR MCP-шлюз: не удалось проверить подключение. Проверьте соединение с сервером OpenCode.";
  }
}

async function checkLlm(baseURL, token) {
  if (!validHttpUrl(baseURL) || !token) return "ERROR LLM-шлюз: проверьте URL и API-токен в provider.tropass.";
  try {
    const response = await fetch(`${baseURL.replace(/\/+$/, "")}/models`, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? `ERROR LLM-шлюз: HTTP ${response.status}, доступ отклонён. Проверьте API-токен и права доступа.`
        : `ERROR LLM-шлюз: HTTP ${response.status}. Проверьте URL и доступность шлюза.`;
    }
    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload?.data) || !payload.data.length
      || payload.data.some((model) => typeof model?.id !== "string" || !model.id.trim())) {
      return "ERROR LLM-шлюз: каталог моделей пуст или имеет неверный формат. Проверьте шлюз и доступные модели.";
    }
    return `OK LLM-шлюз: авторизация выполнена, каталог доступен (${payload.data.length} моделей).`;
  } catch {
    return "ERROR LLM-шлюз: недоступен или истёк таймаут 3 с. Проверьте сеть и URL шлюза.";
  }
}

export function createDoctorCommand(api, options) {
  const run = async () => {
    api.ui.toast({variant: "info", message: "Проверяем Tropass Connect…", duration: 3_000});
    try {
      const message = await diagnoseTropass(api, options);
      api.ui.dialog.replace(() => api.ui.DialogAlert({
        title: "Tropass Connect — диагностика",
        message,
        onConfirm: () => api.ui.dialog.clear(),
      }));
    } catch {
      api.ui.toast({variant: "error", message: "Не удалось выполнить диагностику. Перезапустите OpenCode и повторите /doctor.", duration: 10_000});
    }
  };

  return {name: "doctor", title: "Диагностика Tropass Connect", run};
}
