import type { SqlRow } from "@anynote/types/runtime.js";
const dayMs = 86400000;
export interface CalendarPolicy {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
}
export function calendarPolicy(value: unknown = {}): CalendarPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("采样策略无效");
  const limits = { dailyDays: 365, weeklyWeeks: 104, monthlyMonths: 120 };
  if (Object.keys(value).some((key) => !(key in limits)))
    throw Error("采样策略字段无效");
  const policy = {} as CalendarPolicy;
  for (const [key, max] of Object.entries(limits) as [
    keyof CalendarPolicy,
    number,
  ][]) {
    const count =
      (value as Record<string, unknown>)[key] === undefined
        ? 0
        : (value as Record<string, unknown>)[key];
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0 ||
      count > max
    )
      throw Error("采样策略超出预算");
    policy[key] = count;
  }
  return policy;
}
function time(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    throw Error("版本时间无效，无法安全规划保留策略");
  return Date.parse(value);
}
const week = (value: number) => {
  const d = new Date(value),
    date = Math.floor(value / dayMs);
  return date - ((d.getUTCDay() + 6) % 7);
};
const month = (value: number) => {
  const d = new Date(value);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
// UTC calendar windows include the current day, Monday-based week and month.
// The preview's reference time is reused during confirmation across boundaries.
export function sampleVersions(
  rows: { id: string; created_at: string }[],
  keep: number,
  policy: CalendarPolicy,
  referenceTime: string,
) {
  const now = time(referenceTime),
    today = Math.floor(now / dayMs),
    thisWeek = week(now),
    thisMonth = month(now);
  const ordered = rows
    .map((g) => ({ ...g, time: time(g.created_at) }))
    .sort(
      (a, b) => b.time - a.time || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const retained = new Map<string, string[]>();
  const protect = (g: SqlRow, reason: string) => {
    if (!retained.has(g.id)) retained.set(g.id, []);
    retained.get(g.id)!.push(reason);
  };
  ordered.slice(0, keep).forEach((g) => protect(g, "latest"));
  const seen = { daily: new Set(), weekly: new Set(), monthly: new Set() };
  for (const g of ordered) {
    // Preserve future-dated versions rather than using clock skew to discard them.
    if (g.time > now) {
      protect(g, "future");
      continue;
    }
    const buckets: [keyof typeof seen, number, number, number][] = [
      [
        "daily",
        Math.floor(g.time / dayMs),
        today - policy.dailyDays + 1,
        today,
      ],
      [
        "weekly",
        week(g.time),
        thisWeek - (policy.weeklyWeeks - 1) * 7,
        thisWeek,
      ],
      [
        "monthly",
        month(g.time),
        thisMonth - policy.monthlyMonths + 1,
        thisMonth,
      ],
    ];
    for (const [kind, key, start, end] of buckets) {
      if (key >= start && key <= end && !seen[kind].has(key)) {
        seen[kind].add(key);
        protect(g, kind);
      }
    }
  }
  return [...retained].map(([id, reasons]) => ({ id, reasons }));
}
