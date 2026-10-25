import type { ReactNode } from "react";
import "../management.css";

/** Shared desktop utility surface, separate from the notebook paper. */
export function ManagementPage({
  title,
  description,
  icon,
  scope,
  children,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  scope: string;
  children: ReactNode;
}) {
  return (
    <div className="page management-page">
      <header className="management-header">
        <div className="management-icon" aria-hidden="true">
          {icon}
        </div>
        <div>
          <div className="management-context">
            工作区偏好 <span>{scope}</span>
          </div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </div>
  );
}
