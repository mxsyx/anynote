import type { ReactNode } from "react";
import { AlertCircle, BookOpen, LoaderCircle } from "../../icons";
import { cn } from "../../lib/utils";

/** A quiet paper inset for asynchronous and empty views; actions stay with the caller. */
export function ViewState({
  kind = "empty",
  title,
  children,
  action,
  className,
}: {
  kind?: "loading" | "empty" | "error";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const Icon =
    kind === "loading"
      ? LoaderCircle
      : kind === "error"
        ? AlertCircle
        : BookOpen;

  return (
    <div
      className={cn("view-state", className)}
      data-kind={kind}
      role={kind === "error" ? "alert" : "status"}
      aria-busy={kind === "loading"}
    >
      <Icon size={24} aria-hidden="true" />
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="view-state-actions">{action}</div>}
    </div>
  );
}
