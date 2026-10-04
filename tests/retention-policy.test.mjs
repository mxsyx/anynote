import { test } from "vitest";
import assert from "node:assert/strict";
import {
  calendarPolicy,
  sampleVersions,
} from "../.build/apps/cloudflare-backup/src/retention-policy.js";
const row = (id, created_at) => ({ id, created_at });

test("UTC sampling unions newest day, Monday week and month representatives across a year boundary", () => {
  const rows = [
    row("jan5", "2026-01-05T10:00:00Z"),
    row("jan4-new", "2026-01-04T18:00:00Z"),
    row("jan4-old", "2026-01-04T10:00:00Z"),
    row("dec31", "2025-12-31T23:00:00Z"),
    row("dec1", "2025-12-01T10:00:00Z"),
    row("nov30", "2025-11-30T23:00:00Z"),
  ];
  const selected = sampleVersions(
    rows.reverse(),
    1,
    calendarPolicy({ dailyDays: 2, weeklyWeeks: 2, monthlyMonths: 2 }),
    "2026-01-05T12:00:00Z",
  );
  assert.deepEqual(selected, [
    { id: "jan5", reasons: ["latest", "daily", "weekly", "monthly"] },
    { id: "jan4-new", reasons: ["daily", "weekly"] },
    { id: "dec31", reasons: ["monthly"] },
  ]);
});

test("sampling handles leap days, absolute offsets, deterministic ties and future clock skew", () => {
  const rows = [
    row("b", "2024-03-01T00:30:00Z"),
    row("a", "2024-02-29T19:30:00-05:00"),
    row("leap", "2024-02-29T23:30:00Z"),
    row("future", "2024-03-03T10:00:00Z"),
  ];
  const selected = sampleVersions(
    rows,
    1,
    calendarPolicy({ dailyDays: 2, monthlyMonths: 2 }),
    "2024-03-01T12:00:00Z",
  );
  assert.deepEqual(selected, [
    { id: "future", reasons: ["latest", "future"] },
    { id: "b", reasons: ["daily", "monthly"] },
    { id: "leap", reasons: ["daily", "monthly"] },
  ]);
});

test("invalid policies and ambiguous timestamps fail before selecting deletion candidates", () => {
  for (const p of [
    null,
    [],
    { dailyDays: -1 },
    { weeklyWeeks: 105 },
    { monthlyMonths: 1.5 },
    { daily: 7 },
  ])
    assert.throws(() => calendarPolicy(p));
  assert.throws(
    () =>
      sampleVersions(
        [row("bad", "2026-01-05")],
        1,
        calendarPolicy(),
        "2026-01-05T12:00:00Z",
      ),
    /时间无效/,
  );
  assert.throws(
    () =>
      sampleVersions(
        [row("bad", "invalid")],
        1,
        calendarPolicy(),
        "2026-01-05T12:00:00Z",
      ),
    /时间无效/,
  );
  assert.deepEqual(
    sampleVersions(
      [row("one", "2026-01-04T12:00:00Z"), row("two", "2026-01-03T12:00:00Z")],
      1,
      calendarPolicy(),
      "2026-01-05T12:00:00Z",
    ),
    [{ id: "one", reasons: ["latest"] }],
  );
});
