/**
 * Label quoting — the single most common source of invalid Mermaid output.
 *
 * Mermaid only treats a label as a single token when it is wrapped in `["..."]`.
 * Anything containing whitespace, brackets, quotes or punctuation that would
 * otherwise end the shape must be quoted, otherwise the diagram silently
 * changes meaning or fails to parse.
 *
 * ## Why double quotes become `&quot;`
 *
 * The obvious escape, `A["a \"b\" c"]`, is NOT valid Mermaid. The lexer's string
 * token only tolerates an escaped quote when it closes the label, so `\"` works
 * in `A["\"hi\""]` and `A["He said \"hi\""]` but fails as soon as text follows
 * it (`A["a \"b\" c"]` and `A["x\"y"]` both error with `got 'STR'`). The only
 * form Mermaid renders everywhere is the HTML entity, so `"` is written as
 * `&quot;`. Mermaid then displays a real double quote.
 *
 * `&` is therefore added to the quoting set: a label containing an entity must
 * stay quoted, or `quoteLabel` would emit it as bare text and lose the shape.
 *
 * The "already escaped" guard below only treats *named* entities as done. It
 * deliberately ignores numeric ones (`&#40;`), because Mermaid 11.17.2 renders
 * those as a bare `&` with the `;` dropped; a label that already contains one
 * gets it escaped to `&amp;#40;`, which is at least literal and correct.
 */

// `@` is included even though it looks harmless: mermaid's lexer rejects it in
// a bare label, but accepts it inside `["..."]`.
const NEEDS_QUOTING = /[\s[\]{}()<>|;#:"'`\\,.\-&@]/;

/**
 * Render `label` as Mermaid source text for use inside `shape` brackets.
 * Returns either a bare word (safe case) or a quoted string.
 *
 * Idempotent: a label that already contains an entity (e.g. the `&quot;` this
 * function itself emits) is quoted again but not re-escaped, so repeatedly
 * renaming or reshaping a node never accumulates `&amp;quot;`.
 */
export function quoteLabel(label: string): string {
  if (label === '') return '';
  // Already-safe bare word: identifier-ish characters only.
  if (!NEEDS_QUOTING.test(label) && !/^[0-9]/.test(label)) return label;
  // Only *named* entities count as already-final. Numeric ones (`&#40;`) are
  // escaped to `&amp;#40;` on purpose: Mermaid 11.17.2 renders a numeric
  // entity as a bare `&` with the `;` dropped, so passing it through would
  // silently corrupt the label. See tests/e2e/entities.spec.ts.
  const escaped = label.replace(/&(?!(?:[a-zA-Z]+);)/g, '&amp;')
    .replace(/"/g, '&quot;');
  return `"${escaped}"`;
}

/**
 * Render a label for an *edge*, which mermaid writes as `A -->|label| B`.
 *
 * Two constraints, both verified against `mermaid.parse`:
 *  - the pipes already delimit the span, so a quoted `|"a"|` is invalid; the
 *    text must stay a bare token or an entity-escaped one;
 *  - `[` and `]` are shape delimiters even inside the pipes, so they are
 *    entity-escaped too. A space is fine, but an empty label (`||`) is not.
 *
 * Named entities only. Mermaid 11.17.2 mangles *numeric* ones: `&#40;` comes
 * back out of the renderer as `&` (the `;` is lost), so `a&#40;b` renders as
 * `a&b`. Every name below is verified to round-trip through `mermaid.render`
 * in tests/e2e/entities.spec.ts.
 */
export function edgeLabelText(label: string): string {
  return label
    .replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '&vert;')
    .replace(/\[/g, '&lsqb;')
    .replace(/\]/g, '&rsqb;')
    // Parentheses and braces are shape delimiters in mermaid's lexer and are
    // rejected inside `|...|` even though they look like plain text.
    .replace(/\(/g, '&lpar;')
    .replace(/\)/g, '&rpar;')
    .replace(/\{/g, '&lbrace;')
    .replace(/\}/g, '&rbrace;')
    .replace(/@/g, '&commat;');
}

/**
 * Wrap `label` into the given shape brackets, quoting only when needed.
 * `shape` is the pair of delimiters, e.g. `['[', ']']`.
 */
export function shapeText(
  label: string,
  open: string,
  close: string,
): string {
  return `${open}${quoteLabel(label)}${close}`;
}

/** Delimiter pairs for every supported node shape. */
export const SHAPE_DELIMS: Record<string, [string, string]> = {
  rect: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  asym: ['>', ']'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  bang: [')(', ')('],
};

/**
 * Best shape to use when a node is newly created or its shape is unknown.
 * Quoting matters most for a rectangle, which is the most permissive container.
 */
export function defaultShapeFor(label: string): string {
  return 'rect';
}

export function delimsForShape(shape: string): [string, string] {
  return SHAPE_DELIMS[shape] ?? SHAPE_DELIMS.rect;
}

/**
 * True when a label must be quoted to round-trip through the parser.
 * Exported for tests that assert the fuzz invariant.
 */
export function labelNeedsQuoting(label: string): boolean {
  return NEEDS_QUOTING.test(label);
}