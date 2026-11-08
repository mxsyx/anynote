import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBlocks } from "../packages/protocol/src/markdown";
import { richBlocks } from "../packages/protocol/src/rich";

const corpus = JSON.parse(
  readFileSync(
    new URL("./fixtures/markdown/rm15.json", import.meta.url),
    "utf8",
  ),
) as {
  name: string;
  parts: { text: string; repeat: number }[];
  expected: unknown;
}[];

describe("RM15 shared Rust/TS Markdown corpus", () => {
  for (const fixture of corpus) {
    it(fixture.name, () => {
      const source = fixture.parts
        .map((part) => part.text.repeat(part.repeat))
        .join("");
      const byte = (offset: number) =>
        Buffer.byteLength(source.slice(0, offset));
      expect({
        segments: parseBlocks(source).map((block) => ({
          start: byte(block.start),
          end: byte(block.end),
          ...(block.kind === "extension"
            ? {
                attrs: block.attrs,
                data: block.data ?? null,
                validJson: block.data !== undefined,
              }
            : {}),
        })),
        blocks: richBlocks(source).map((block) => ({
          start: byte(block.start),
          end: byte(block.end),
          reason: block.reason ?? null,
        })),
      }).toEqual(fixture.expected);
    });
  }
});
