export function formatUsage(data, locale, timeZone) {
  const usage = data?.usage ?? data?.data ?? data;
  const used = Number(usage?.used ?? usage?.used_tokens);
  const limitValue = usage?.limit ?? usage?.limit_tokens ?? usage?.initial_limit_tokens;
  const remainingValue = usage?.remaining ?? usage?.remaining_tokens;
  const limit = limitValue === null ? null : Number(limitValue);
  const remaining = remainingValue === null ? null : Number(remainingValue);
  const reset = usage?.resetAt ?? usage?.reset_time ?? usage?.reset_at;
  if (!Number.isFinite(used) || (limit !== null && !Number.isFinite(limit)) || (remaining !== null && !Number.isFinite(remaining)) || reset === undefined) {
    return JSON.stringify(data, null, 2);
  }

  const percent = limit === null ? null : Math.min(100, Math.max(0, limit > 0 ? Math.round(used / limit * 100) : 0));
  const filled = percent === null ? 0 : Math.round(percent * 24 / 100);
  const number = new Intl.NumberFormat(locale).format;
  const resetDate = new Date(typeof reset === "number" && reset < 1e12 ? reset * 1000 : reset);
  const resetText = reset === null ? "Not scheduled" : Number.isNaN(resetDate.valueOf())
    ? String(reset)
    : new Intl.DateTimeFormat(locale, {dateStyle: "medium", timeStyle: "short", timeZone}).format(resetDate);

  return [
    "Weekly tokens",
    "",
    percent === null ? "──────────────────────── ∞" : `${"█".repeat(filled)}${"░".repeat(24 - filled)} ${percent}%`,
    "",
    `Used       ${number(used)}`,
    `Remaining  ${remaining === null ? "Unlimited" : number(remaining)}`,
    `Limit      ${limit === null ? "Unlimited" : number(limit)}`,
    `Resets     ${resetText}`,
  ].join("\n");
}

export function createUsageCommand(api, {usageUrl, apiToken}) {
  const run = async () => {
    try {
      api.ui.toast({variant: "info", message: "Loading Tropass usage…", duration: 2_000});
      const response = await fetch(usageUrl, {headers: {Authorization: `Bearer ${apiToken}`}});
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body}`);
      let message = body;
      try {
        message = formatUsage(JSON.parse(body));
      } catch {}
      api.ui.dialog.replace(() => api.ui.DialogAlert({
        title: "Tropass usage",
        message,
        onConfirm: () => api.ui.dialog.clear(),
      }));
    } catch (error) {
      api.ui.toast({
        variant: "error",
        message: error instanceof Error ? error.message : String(error),
        duration: 10_000,
      });
    }
  };

  return {name: "usage", title: "Tropass token usage", run};
}
