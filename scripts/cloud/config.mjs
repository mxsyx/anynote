const required = {
  cloudflare: ["ANYNOTE_CF_ENDPOINT", "ANYNOTE_CF_TOKEN"],
  s3: [
    "ANYNOTE_S3_ENDPOINT",
    "ANYNOTE_S3_BUCKET",
    "ANYNOTE_S3_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ],
};
export function readCloudConfig(
  provider,
  env = process.env,
  { allowLocalHTTP = false } = {},
) {
  const missing = required[provider].filter((key) => !env[key]?.trim());
  if (missing.length) return { missing };
  const endpoint = new URL(
    env[provider === "s3" ? "ANYNOTE_S3_ENDPOINT" : "ANYNOTE_CF_ENDPOINT"],
  );
  const localHTTP =
    allowLocalHTTP &&
    provider === "s3" &&
    endpoint.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (
    (endpoint.protocol !== "https:" && !localHTTP) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw Error(
      "真实云验收要求 HTTPS 地址，且地址不能包含凭据、查询参数或片段",
    );
  if (provider === "cloudflare")
    return {
      config: { endpoint: endpoint.href.replace(/\/$/, "") },
      secrets: { token: env.ANYNOTE_CF_TOKEN },
    };
  return {
    config: {
      endpoint: endpoint.href,
      bucket: env.ANYNOTE_S3_BUCKET,
      region: env.ANYNOTE_S3_REGION,
      pathStyle: env.ANYNOTE_S3_PATH_STYLE !== "false",
      ...(localHTTP ? { allowInsecure: true } : {}),
    },
    secrets: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
    },
  };
}
export function redact(value, env = process.env) {
  let serialized = JSON.stringify(value);
  for (const key of [
    "ANYNOTE_CF_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "CLOUDFLARE_API_TOKEN",
  ])
    if (env[key])
      serialized = serialized
        .split(JSON.stringify(env[key]).slice(1, -1))
        .join("[REDACTED]");
  return JSON.parse(serialized);
}
