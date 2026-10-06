import { useState } from "react";
import type { DeclarativeNode } from "@anynote/plugin-sdk/declarative";
import { parseBlocks } from "@anynote/protocol/markdown";

/** Render a declarative extension block read-only (callout or details). */
export function PluginBlock({
  node,
  data,
}: {
  node: DeclarativeNode;
  data: Record<string, unknown>;
}) {
  const fields = node.fields.map((f) => (
    <p key={f.key}>
      <strong>{f.label}</strong>
      <span>
        {typeof data[f.key] === "string" ? (data[f.key] as string) : ""}
      </span>
    </p>
  ));
  return node.presentation === "details" ? (
    <details className="plugin-block">
      <summary>{node.title}</summary>
      {fields}
    </details>
  ) : (
    <aside className="plugin-block" aria-label={node.title}>
      <strong>{node.title}</strong>
      {fields}
    </aside>
  );
}

/** Edit a declarative extension block's fields in place. */
export function PluginBlockEditor({
  node,
  source,
  onDone,
  onChange,
}: {
  node: DeclarativeNode;
  source: string;
  onDone: () => void;
  onChange: (value: string) => void;
}) {
  const block = parseBlocks(source)[0];
  const [values, setValues] = useState<Record<string, unknown>>(
    block.kind === "extension" &&
      block.data &&
      typeof block.data === "object" &&
      !Array.isArray(block.data)
      ? (block.data as Record<string, unknown>)
      : {},
  );
  return (
    <div className="rich-editing">
      <strong>{node.title}</strong>
      {node.fields.map((f) => (
        <label key={f.key}>
          {f.label}
          <textarea
            aria-label={f.label}
            value={
              typeof values[f.key] === "string" ? (values[f.key] as string) : ""
            }
            maxLength={2000}
            onChange={(e) => {
              const next = { ...values, [f.key]: e.target.value };
              setValues(next);
              const first = source.indexOf("\n"),
                last = source.lastIndexOf(":::");
              onChange(
                source.slice(0, first + 1) +
                  JSON.stringify(next) +
                  "\n" +
                  source.slice(last),
              );
            }}
          />
        </label>
      ))}
      <button className="secondary" onClick={onDone}>
        完成此块
      </button>
    </div>
  );
}
