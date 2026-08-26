import {
  mapCreateTaskToWire,
  mapUpdateTaskToWire,
  mapCreateEventToWire,
  mapCreateCommentToWire,
  mapColumnFromWire,
  mapTaskFromWire,
  type CreateCommentInput,
} from './mapping';
import type { Task, WireTask } from './types';

// No network anywhere in this file — mapping.ts is pure and must never
// contact the API.

describe('table-driven: the six tool-vocab -> wire-vocab renames', () => {
  const cases: Array<{
    name: string;
    toolKey: string;
    wireKey: string;
    value: unknown;
    run: () => Record<string, unknown>;
  }> = [
    {
      name: 'task create: title -> title_text',
      toolKey: 'title',
      wireKey: 'title_text',
      value: 'Ship the thing',
      run: () =>
        mapCreateTaskToWire({ title: 'Ship the thing' }) as unknown as Record<string, unknown>,
    },
    {
      name: 'task create: due_date -> end_date',
      toolKey: 'due_date',
      wireKey: 'end_date',
      value: '2026-03-01',
      run: () =>
        mapCreateTaskToWire({ title: 'x', due_date: '2026-03-01' }) as unknown as Record<
          string,
          unknown
        >,
    },
    {
      name: 'task create: due_time -> end_time',
      toolKey: 'due_time',
      wireKey: 'end_time',
      value: '14:30',
      run: () =>
        mapCreateTaskToWire({ title: 'x', due_time: '14:30' }) as unknown as Record<
          string,
          unknown
        >,
    },
    {
      name: 'task create: assignee_ids -> user_ids',
      toolKey: 'assignee_ids',
      wireKey: 'user_ids',
      value: ['user_1', 'user_2'],
      run: () =>
        mapCreateTaskToWire({ title: 'x', assignee_ids: ['user_1', 'user_2'] }) as unknown as Record<
          string,
          unknown
        >,
    },
    {
      name: 'task create: column_id -> card_id',
      toolKey: 'column_id',
      wireKey: 'card_id',
      value: 'card_9',
      run: () =>
        mapCreateTaskToWire({ title: 'x', column_id: 'card_9' }) as unknown as Record<
          string,
          unknown
        >,
    },
    {
      name: 'event create: invited_user_ids -> invited_users',
      toolKey: 'invited_user_ids',
      wireKey: 'invited_users',
      value: ['user_3', 'user_4'],
      run: () =>
        mapCreateEventToWire({
          title: 'Standup',
          date: '2026-03-01',
          start_time: '09:00',
          end_time: '09:15',
          repeat: 'none',
          invited_user_ids: ['user_3', 'user_4'],
        }) as unknown as Record<string, unknown>,
    },
  ];

  it.each(cases)('$name', ({ run, toolKey, wireKey, value }) => {
    const wire = run();
    expect(wire[wireKey]).toEqual(value);
    expect(Object.prototype.hasOwnProperty.call(wire, toolKey)).toBe(false);
  });
});

describe('dedicated regression: invited_user_ids -> invited_users on event create', () => {
  // Deliberately independent of the table-driven suite above, per the task
  // brief: this row is the one the original design draft omitted (it would
  // have created every event with zero invitees, silently, with no error).
  // Deleting the corresponding table row must not be enough to go green.
  it('renames invited_user_ids to invited_users and drops the tool-vocab key', () => {
    const wire = mapCreateEventToWire({
      title: 'Planning',
      date: '2026-04-10',
      start_time: '10:00',
      end_time: '10:30',
      repeat: 'none',
      invited_user_ids: ['user_a', 'user_b'],
    }) as unknown as Record<string, unknown>;

    expect(wire.invited_users).toEqual(['user_a', 'user_b']);
    expect(Object.prototype.hasOwnProperty.call(wire, 'invited_user_ids')).toBe(false);
  });
});

describe('no write mapper leaks a tool-vocabulary key onto the wire object', () => {
  const ALL_SIX = ['title', 'due_date', 'due_time', 'assignee_ids', 'column_id', 'invited_user_ids'];

  // Events do NOT rename `title` — the wire field for an event's title
  // really is `title` (StorePublicEventRequest.php:55, and OpenAPI
  // :820-822), unlike a task's `title_text`. So 'title' is excluded from
  // the event mapper's banned list on purpose: a `title` key on that wire
  // object is correct, not a leak. See mapping.ts's comment on
  // mapCreateEventToWire for the full reasoning.
  const EVENT_KEYS = ALL_SIX.filter((key) => key !== 'title');

  it('mapCreateTaskToWire', () => {
    const wire = mapCreateTaskToWire({
      title: 'x',
      column_id: 'card_1',
      project_id: 'proj_1',
      description: 'd',
      priority: 'low',
      progress: 10,
      due_date: '2026-01-01',
      due_time: '09:00',
      assignee_ids: ['u1'],
    }) as unknown as Record<string, unknown>;

    for (const key of ALL_SIX) {
      expect(Object.prototype.hasOwnProperty.call(wire, key)).toBe(false);
    }
  });

  it('mapUpdateTaskToWire', () => {
    const wire = mapUpdateTaskToWire({
      title: 'x',
      description: 'd',
      priority: 'low',
      progress: 10,
      due_date: '2026-01-01',
      due_time: '09:00',
    }) as unknown as Record<string, unknown>;

    for (const key of ALL_SIX) {
      expect(Object.prototype.hasOwnProperty.call(wire, key)).toBe(false);
    }
  });

  it('mapCreateEventToWire', () => {
    const wire = mapCreateEventToWire({
      title: 'x',
      date: '2026-01-01',
      start_time: '09:00',
      end_time: '09:15',
      repeat: 'none',
      invited_user_ids: ['u1'],
    }) as unknown as Record<string, unknown>;

    for (const key of EVENT_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(wire, key)).toBe(false);
    }
    // Proves the check above isn't vacuously true: the real wire key IS present.
    expect(wire.title).toBe('x');
    expect(wire.invited_users).toEqual(['u1']);
  });

  it('mapCreateCommentToWire', () => {
    const wire = mapCreateCommentToWire({ body: 'hello' }) as unknown as Record<string, unknown>;

    for (const key of ALL_SIX) {
      expect(Object.prototype.hasOwnProperty.call(wire, key)).toBe(false);
    }
  });
});

describe('update: explicit null survives, an omitted key is absent (never present-as-undefined)', () => {
  it('due_date: null produces end_date present and null', () => {
    const wire = mapUpdateTaskToWire({ due_date: null }) as unknown as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(wire, 'end_date')).toBe(true);
    expect(wire.end_date).toBeNull();
  });

  it('due_date omitted produces no end_date key at all', () => {
    const wire = mapUpdateTaskToWire({ title: 'only this changed' }) as unknown as Record<
      string,
      unknown
    >;

    expect(Object.prototype.hasOwnProperty.call(wire, 'end_date')).toBe(false);
  });

  it('an entirely empty update input produces a wire object with zero own keys', () => {
    const wire = mapUpdateTaskToWire({}) as unknown as Record<string, unknown>;

    expect(Object.keys(wire)).toHaveLength(0);
  });

  it('due_time follows the same omitted-vs-null rule as due_date', () => {
    const withNull = mapUpdateTaskToWire({ due_time: null }) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(withNull, 'end_time')).toBe(true);
    expect(withNull.end_time).toBeNull();

    const omitted = mapUpdateTaskToWire({ progress: 50 }) as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(omitted, 'end_time')).toBe(false);
  });
});

describe('read direction: task.card becomes task.column + task.column_id', () => {
  const wireTask: WireTask = {
    id: 'task_1',
    title: 'Ship it',
    description: null,
    project_id: 'proj_1',
    card: { id: 'card_1', name: 'In Progress', is_done: false },
    priority: 'high',
    due_date: '2026-01-01',
    due_time: '09:00',
    progress: 50,
    completed: false,
    assignee_ids: ['u1', 'u2'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };

  it('mapColumnFromWire maps {id, name, is_done} straight across', () => {
    const column = mapColumnFromWire({ id: 'card_1', name: 'In Progress', is_done: false });
    expect(column).toEqual({ id: 'card_1', name: 'In Progress', is_done: false });
  });

  it('mapTaskFromWire derives column and column_id from card, and never emits a card key', () => {
    const task = mapTaskFromWire(wireTask) as unknown as Record<string, unknown>;

    expect(task.column).toEqual({ id: 'card_1', name: 'In Progress', is_done: false });
    expect(task.column_id).toBe('card_1');

    // Top level: no `card` key.
    expect(Object.prototype.hasOwnProperty.call(task, 'card')).toBe(false);
    // Nested: `column` itself must not carry a stray `card` key either.
    expect(Object.prototype.hasOwnProperty.call(task.column as object, 'card')).toBe(false);
    // Belt and braces: the literal substring never appears anywhere in the output.
    expect(JSON.stringify(task)).not.toContain('"card"');
  });

  it('mapTaskFromWire handles a null card: column and column_id both come out null', () => {
    const task = mapTaskFromWire({ ...wireTask, card: null });
    expect(task.column).toBeNull();
    expect(task.column_id).toBeNull();
  });
});

describe('fields that share a name on both sides pass through unrenamed', () => {
  it('description is copied verbatim on task create (not renamed)', () => {
    const wire = mapCreateTaskToWire({
      title: 'x',
      description: 'a real description',
    }) as unknown as Record<string, unknown>;

    expect(wire.description).toBe('a real description');
  });

  it('id is copied verbatim when reading a task (not renamed)', () => {
    const task = mapTaskFromWire({
      id: 'task_42',
      title: 't',
      description: null,
      project_id: null,
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      created_at: null,
      updated_at: null,
    });

    expect(task.id).toBe('task_42');
  });
});

describe('mapTaskFromWire does not crash on an unknown extra key in the wire response', () => {
  it('ignores an unrecognized field rather than throwing or leaking it into the output', () => {
    const withExtra = {
      id: 'task_1',
      title: 't',
      description: null,
      project_id: null,
      card: null,
      priority: null,
      due_date: null,
      due_time: null,
      progress: null,
      completed: false,
      assignee_ids: [],
      created_at: null,
      updated_at: null,
      some_future_field_the_backend_added: 'surprise',
    } as unknown as WireTask;

    let task: Task | undefined;
    expect(() => {
      task = mapTaskFromWire(withExtra);
    }).not.toThrow();

    expect(task).toBeDefined();
    expect(
      Object.prototype.hasOwnProperty.call(task as object, 'some_future_field_the_backend_added')
    ).toBe(false);
  });
});

describe('mapCreateCommentToWire', () => {
  it('maps body verbatim (no rename)', () => {
    const wire = mapCreateCommentToWire({ body: 'nice work' });
    expect(wire).toEqual({ body: 'nice work' });
  });

  it('never emits mention_user_ids, even if a caller forces one in via a type cast', () => {
    const input = { body: 'nice work', mention_user_ids: ['u1'] } as unknown as CreateCommentInput;
    const wire = mapCreateCommentToWire(input) as unknown as Record<string, unknown>;

    expect(Object.prototype.hasOwnProperty.call(wire, 'mention_user_ids')).toBe(false);
    expect(wire.body).toBe('nice work');
  });
});

describe('mapCreateEventToWire always includes the required wire fields', () => {
  it('sets title, date, start_time, end_time, repeat directly, no optional fields present', () => {
    const wire = mapCreateEventToWire({
      title: 'Retro',
      date: '2026-05-01',
      start_time: '15:00',
      end_time: '15:30',
      repeat: 'weekly',
    }) as unknown as Record<string, unknown>;

    expect(wire).toEqual({
      title: 'Retro',
      date: '2026-05-01',
      start_time: '15:00',
      end_time: '15:30',
      repeat: 'weekly',
    });
  });
});
