/**
 * Token-bounding for tool outputs.
 *
 * These are defensive backstops on a single tool result — not the primary
 * pagination mechanism. `next_cursor` (opaque, passed through by
 * `src/api/client.ts` verbatim) is what a caller uses to page through a
 * large list properly; `listEnvelope`'s `MAX_LIST_ITEMS` cap exists in case
 * a single page turns out to be larger than that regardless, and
 * `truncateText`'s `TEXT_CAP` exists so one verbose field can't blow a
 * result on its own. Neither cap decides whether more data exists —
 * `next_cursor` is passed through untouched either way.
 */

/** The default character cap `truncateText` applies when no override is given. */
export const TEXT_CAP = 8000;

/** Appended to a truncated string. The result can therefore run slightly past `cap` — that fixed cost is what makes truncation visible rather than silent. */
export const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Returns `text` unchanged when it's within `cap`. Otherwise returns the
 * first `cap` characters followed by `TRUNCATION_MARKER`.
 */
export function truncateText(text: string, cap: number = TEXT_CAP): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + TRUNCATION_MARKER;
}

/** The most items a single `listEnvelope` result carries, regardless of how many were given. */
export const MAX_LIST_ITEMS = 50;

export interface ListEnvelope<T> {
  items: T[];
  next_cursor: string | null;
}

/**
 * Caps `items` at `MAX_LIST_ITEMS` and passes `nextCursor` through as
 * `next_cursor` (an omitted or `undefined` cursor becomes `null`, never the
 * literal string `"undefined"`). This function does not decide whether more
 * pages exist — it only bounds what a single response hands back.
 */
export function listEnvelope<T>(items: T[], nextCursor?: string | null): ListEnvelope<T> {
  // Deliberately does NOT slice. Slicing here while forwarding the upstream
  // cursor silently DROPPED rows: the API's cursor is derived from the last
  // row of the page it actually returned, so any page larger than the cap
  // lost the rows between the cap and the cursor — permanently, with no
  // signal. The page is bounded at the request instead (`limitSchema` is
  // capped at MAX_LIST_ITEMS), so a page can never exceed the cap; if a
  // server ever returns more anyway, passing it through is strictly safer
  // than dropping rows the cursor will also skip.
  return {
    items,
    next_cursor: nextCursor ?? null,
  };
}

/**
 * Field names a LIST view must never carry the full value of — long free
 * text that's only useful once a caller has drilled into a single record.
 * Detail views keep these fields but run them through `truncateText`
 * instead of dropping them; omission is list-only.
 */
export const LIST_OMITTED_FIELDS = ['description', 'content', 'body', 'notes'] as const;

/**
 * Shallow-copies `record` with `LIST_OMITTED_FIELDS` removed. Every other
 * field — `id`, `title`, and anything else the caller included — passes
 * through unchanged.
 */
export function omitLongText<T extends Record<string, unknown>>(record: T): T {
  const copy: Record<string, unknown> = { ...record };
  for (const field of LIST_OMITTED_FIELDS) {
    delete copy[field];
  }
  return copy as T;
}
