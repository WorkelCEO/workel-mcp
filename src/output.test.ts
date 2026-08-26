import { LIST_OMITTED_FIELDS, MAX_LIST_ITEMS, TRUNCATION_MARKER, listEnvelope, omitLongText, truncateText } from './output';
import { limitSchema } from './tools/conventions';

describe('truncateText', () => {
  it('returns a short string unchanged, with no marker appended', () => {
    const text = 'a short string';

    const result = truncateText(text, 100);

    expect(result).toBe(text);
    expect(result).not.toContain(TRUNCATION_MARKER);
  });

  it('keeps the first `cap` characters and appends the truncation marker when the string exceeds cap', () => {
    const cap = 10;
    const text = 'x'.repeat(cap + 50);

    const result = truncateText(text, cap);

    expect(result).toBe('x'.repeat(cap) + TRUNCATION_MARKER);
    expect(result.startsWith('x'.repeat(cap))).toBe(true);
    expect(result.endsWith(TRUNCATION_MARKER)).toBe(true);
  });

  it('treats a string exactly at the cap as within bounds — unchanged, no marker', () => {
    const cap = 10;
    const text = 'x'.repeat(cap);

    const result = truncateText(text, cap);

    expect(result).toBe(text);
  });
});

describe('omitLongText', () => {
  it('drops description but keeps title and id', () => {
    const record = { id: 't_1', title: 'Task title', description: 'a long body of text' };

    const result = omitLongText(record);

    expect(result).not.toHaveProperty('description');
    expect(result.title).toBe('Task title');
    expect(result.id).toBe('t_1');
  });

  it('does not strip fields outside LIST_OMITTED_FIELDS — over-reach guard', () => {
    const record = {
      id: 't_1',
      title: 'Task title',
      priority: 'high',
      completed: false,
      description: 'a long body of text',
    };

    const result = omitLongText(record);

    expect(result).toMatchObject({ id: 't_1', title: 'Task title', priority: 'high', completed: false });
    expect(Object.keys(result).sort()).toEqual(['completed', 'id', 'priority', 'title']);
  });

  it('drops every field named in LIST_OMITTED_FIELDS when present', () => {
    const record = {
      id: 't_1',
      description: 'x',
      content: 'y',
      body: 'z',
      notes: 'w',
    };

    const result = omitLongText(record);

    for (const field of LIST_OMITTED_FIELDS) {
      expect(result).not.toHaveProperty(field);
    }
    expect(result.id).toBe('t_1');
  });
});

describe('omission is list-only: a detail record truncates description rather than dropping it', () => {
  it('keeps the field, truncated, when the caller runs it through truncateText instead of omitLongText', () => {
    const detail = { id: 't_1', title: 'Task', description: 'x'.repeat(30) };

    const rendered = { ...detail, description: truncateText(detail.description, 10) };

    expect(rendered).toHaveProperty('description');
    expect(rendered.description).toBe('x'.repeat(10) + TRUNCATION_MARKER);
  });
});

describe('listEnvelope', () => {
  it('returns an empty items array and next_cursor: null for an empty list with no cursor', () => {
    const result = listEnvelope([], undefined);

    expect(result).toEqual({ items: [], next_cursor: null });
  });

  it('passes a real cursor through untouched', () => {
    const result = listEnvelope([1, 2, 3], 'cursor_abc');

    expect(result).toEqual({ items: [1, 2, 3], next_cursor: 'cursor_abc' });
  });

  // REGRESSION: this previously sliced to MAX_LIST_ITEMS while forwarding the
  // upstream cursor. The API's cursor is derived from the LAST row of the page
  // it returned, so every row between the cap and the cursor was dropped
  // permanently, with no signal to the caller — verified live against a
  // 234-project workspace: asking for 100 returned 50 and a cursor that
  // skipped rows 51-100. Rows are never dropped now; the page is bounded at
  // the request instead (see limitSchema).
  it('never drops rows, even when handed more than MAX_LIST_ITEMS', () => {
    const items = Array.from({ length: 55 }, (_, i) => i);

    const result = listEnvelope(items, 'cursor_x');

    expect(result.items).toHaveLength(55);
    expect(result.items).toEqual(items);
    expect(result.next_cursor).toBe('cursor_x');
  });
});

describe('the request bound is what keeps a page small', () => {
  it('limitSchema cannot ask for more rows than one envelope carries', () => {
    // The two bounds must agree. If limitSchema ever exceeds MAX_LIST_ITEMS
    // again, a page can outgrow the envelope and the drop-vs-cursor mismatch
    // returns.
    expect(limitSchema.parse(MAX_LIST_ITEMS)).toBe(MAX_LIST_ITEMS);
    expect(() => limitSchema.parse(MAX_LIST_ITEMS + 1)).toThrow();
    expect(limitSchema.parse(undefined)).toBeLessThanOrEqual(MAX_LIST_ITEMS);
  });
});
