import type { DurableObjectState } from "@cloudflare/workers-types";
import type { WorkerEnv } from "@anynote/types/runtime.js";
import { maintenance, state } from "./maintenance.js";

/** One globally unique actor per Notebook. No time-based stealing of a live lock. */
export class MaintenanceCoordinator {
  private owner = crypto.randomUUID();
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  constructor(
    private ctx: DurableObjectState,
    private env: WorkerEnv,
  ) {}
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    this.ctx.waitUntil(this.queue);
    return job;
  }
  private async initialize(book: string) {
    const prior = await this.ctx.storage.get<string>("book");
    if (prior && prior !== book) throw Error("维护协调器身份不匹配");
    if (!prior) await this.ctx.storage.put("book", book);
    if (!this.initialized) {
      // A new actor incarnation proves its previous JS instance has stopped.
      // Legacy locks without an actor owner are deliberately never stolen.
      await this.env.DB.prepare(
        "UPDATE retention_plans SET execution_id=NULL,execution_owner=NULL WHERE notebook_id=? AND execution_owner IS NOT NULL AND execution_owner<>?",
      )
        .bind(book, this.owner)
        .run();
      this.initialized = true;
    }
  }
  fetch(request: Request) {
    return this.serial(async () => {
      const url = new URL(request.url);
      const match = url.pathname.match(
        /^\/v1\/notebooks\/([a-f0-9-]{36})\/retention\/apply$/i,
      );
      if (!match || request.method !== "POST")
        return Response.json({ error: "接口不存在" }, { status: 404 });
      await this.initialize(match[1]);
      // Persist the alarm before any destructive work. It survives actor resets.
      await this.ctx.storage.setAlarm(Date.now() + 10000);
      try {
        return (await maintenance(
          request,
          this.env,
          match[1],
          "/retention/apply",
          url,
          async (r) => {
            const text = await r.text();
            if (text.length > 65536) throw Error("维护请求预算超限");
            return JSON.parse(text);
          },
          this.owner,
        ))!;
      } finally {
        if (!(await state(this.env, match[1])).maintenance_id)
          await this.ctx.storage.deleteAlarm();
      }
    });
  }
  alarm() {
    return this.serial(async () => {
      const book = await this.ctx.storage.get<string>("book");
      if (!book) return;
      await this.initialize(book);
      const current = await state(this.env, book);
      if (!current.maintenance_id) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const plan = await this.env.DB.prepare(
        "SELECT * FROM retention_plans WHERE id=? AND notebook_id=? AND status='deleting'",
      )
        .bind(current.maintenance_id, book)
        .first();
      if (!plan) return;
      if (plan.execution_id && !plan.execution_owner) {
        await this.ctx.storage.deleteAlarm();
        return;
      }

      // Only a previously confirmed deleting plan is eligible for automatic work.
      await this.ctx.storage.setAlarm(Date.now() + 30000);
      const response = await maintenance(
        new Request(
          `https://maintenance.invalid/v1/notebooks/${book}/retention/apply`,
          {
            method: "POST",
            body: JSON.stringify({
              planId: plan.id,
              confirmed: true,
              deviceId: plan.writer_id,
              writerEpoch: plan.writer_epoch,
            }),
          },
        ),
        this.env,
        book,
        "/retention/apply",
        new URL("https://maintenance.invalid"),
        async (r) => r.json(),
        this.owner,
      );
      if (response?.ok && !(await state(this.env, book)).maintenance_id)
        await this.ctx.storage.deleteAlarm();
    });
  }
}
