const required = ["ANYNOTE_CF_ENDPOINT", "ANYNOTE_CF_TOKEN"];
export function readCloudConfig(env = process.env) {
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length) return { missing };
  const endpoint = new URL(env.ANYNOTE_CF_ENDPOINT);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error(
      "真实云验收要求 HTTPS 地址，且地址不能包含凭据、查询参数或片段",
    );
  return {
    config: { endpoint: endpoint.href.replace(/\/$/, "") },
    secrets: { token: env.ANYNOTE_CF_TOKEN },
  };
}
export function redact(value, env = process.env) {
  let serialized = JSON.stringify(value);
  for (const key of ["ANYNOTE_CF_TOKEN", "CLOUDFLARE_API_TOKEN"])
    if (env[key])
      serialized = serialized
        .split(JSON.stringify(env[key]).slice(1, -1))
        .join("[REDACTED]");
  return JSON.parse(serialized);
}
