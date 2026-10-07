/** Pattern matching resource references in the body: `anynote-resource:<uuid>`. */
export const resourcePattern = /anynote-resource:([a-f0-9-]{36})/gi;

/** Body block: a plain Markdown segment or a `:::anynote` extension block. */
type Block =
  | { kind: "markdown"; source: string; start: number; end: number }
  | {
      kind: "extension";
      attrs: Record<string, string>;
      data: unknown;
      source: string;
      start: number;
      end: number;
    };

/**
 * Split the body into Markdown segments and `:::anynote{...}` extension blocks.
 *
 * Content inside code fences (``` or ~~~) is protected, so `:::anynote`
 * directives within them are not recognized as extension blocks.
 *
 * @param source Full Markdown body.
 * @returns Blocks in order of appearance.
 */
export function parseBlocks(source: string) {
  const ranges = [];
  let fence = null,
    offset = 0,
    begin = 0;
  for (const line of source.split(/(?<=\n)/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (m) {
      if (!fence) {
        fence = m[1];
        begin = offset;
      } else if (
        m[1][0] === fence[0] &&
        m[1].length >= fence.length &&
        line.slice(m[0].length).trim() === ""
      ) {
        ranges.push([begin, offset + line.length]);
        fence = null;
      }
    }
    offset += line.length;
  }
  if (fence) ranges.push([begin, source.length]);
  const blocks: Block[] = [];
  const pattern =
    /^:::anynote\{([^\n]*)\}\r?\n([\s\S]*?)^:::[ \t]*(?:\r?\n|$)/gm;
  let start = 0,
    match;
  while ((match = pattern.exec(source))) {
    if (ranges.some(([a, b]) => match!.index >= a && match!.index < b))
      continue;
    if (match.index > start)
      blocks.push({
        kind: "markdown",
        source: source.slice(start, match.index),
        start,
        end: match.index,
      });
    const attrs = Object.fromEntries(
      [...match[1].matchAll(/(\w+)="([^"\n]*)"/g)].map((m) => [m[1], m[2]]),
    );
    let data;
    try {
      data = JSON.parse(match[2]);
    } catch {}
    blocks.push({
      kind: "extension",
      attrs,
      data,
      source: match[0],
      start: match.index,
      end: pattern.lastIndex,
    });
    start = pattern.lastIndex;
  }
  if (start < source.length || !blocks.length)
    blocks.push({
      kind: "markdown",
      source: source.slice(start),
      start,
      end: source.length,
    });
  return blocks;
}

/**
 * Collect every resource ID referenced in the body.
 *
 * Besides explicit `anynote-resource:` references, it recursively scans all
 * `*resourceId` fields in extension blocks, covering indirect references such
 * as whiteboard-embedded images.
 *
 * @param body Markdown body.
 * @returns Deduplicated list of resource IDs.
 */
export function resourceIds(body: string) {
  const ids = new Set([...body.matchAll(resourcePattern)].map((m) => m[1]));
  for (const b of parseBlocks(body)) {
    if (b.kind !== "extension" || !b.data) continue;
    const stack = [b.data];
    let budget = 0;
    while (stack.length && budget++ < 10000) {
      const value = stack.pop();
      if (!value || typeof value !== "object") continue;
      for (const [key, v] of Object.entries(value)) {
        if (
          /resourceId$/i.test(key) &&
          typeof v === "string" &&
          /^[a-f0-9-]{36}$/i.test(v)
        )
          ids.add(v);
        else if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return [...ids];
}

/**
 * Generate the Markdown source of a `:::anynote` extension block.
 *
 * @param type Block type.
 * @param id Block ID.
 * @param data Block data.
 * @returns The generated Markdown source.
 */
export function extensionBlock(type: string, id: string, data: unknown) {
  return `:::anynote{type="${type}" version="1" id="${id}"}\n${JSON.stringify(data)}\n:::\n`;
}
