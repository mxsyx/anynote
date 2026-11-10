import { z } from "zod";

const capabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  schemaVersions: z.array(z.number().int().nonnegative().safe()).max(100),
  capabilities: z.array(z.string().min(1).max(128)).max(100),
});

export function requireCloudCapabilities(value: unknown, required: string[]) {
  const parsed = capabilitiesSchema.safeParse(value);
  if (!parsed.success || !parsed.data.schemaVersions.includes(5))
    throw Error("云端协议不受支持，请检查 Worker 版本");
  for (const name of required)
    if (!parsed.data.capabilities.includes(name))
      throw Error(`云端不支持 ${name}，请更新 Worker 后重试`);
  return parsed.data;
}
