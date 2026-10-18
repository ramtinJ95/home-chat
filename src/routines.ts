import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { RoutineSchedule, User } from './api.d.ts';
import { readJson, serialSave } from './files.ts';
import { MAX_ROUTINE_PROMPT, MAX_ROUTINE_TITLE, WEEKDAYS } from './policy.ts';

// Routines: prompts that run on a schedule, each into its own conversation. This module keeps routines.json and one
// timer for the earliest next run; src/server.ts turns a due routine into a turn.
const TIME_ZONE = 'Europe/Stockholm';
const MAX_ROUTINES = 10;
export const MAX_RUNS_PER_DAY = 20;
// A run missed by less than this (the app was down, or the run waited in the queue) still happens once; older ones
// are skipped with a note in the routine's conversation.
export const MISSED_GRACE_MS = 3 * 60 * 60_000;

export interface Routine {
  id: string;
  owner: User;
  // The conversation its runs arrive in.
  chat: string;
  title: string;
  // Self-contained instructions for each run, written by the model when the routine was set up.
  prompt: string;
  schedule: RoutineSchedule;
  // The schedule as a cron pattern (or an ISO date-time for `once`), read in TIME_ZONE.
  cron: string;
  enabled: boolean;
  deepResearch: boolean;
  // ISO instant; null once a one-off has run.
  nextRun: string | null;
  // A run that came due and has not started yet (it waits for a free worker), saved so a restart still runs it.
  pending?: string;
  // `running` from start to finish; found at startup, it means the app stopped during the run.
  lastRun?: {at: string; outcome: 'running' | 'done' | 'failed' | 'skipped'};
}

interface RoutineInput { title?: unknown; prompt?: unknown; schedule?: unknown; deepResearch?: unknown }

const DAY_NAMES = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

// Thrown for input the model can correct; the message goes back to it as the tool result.
export class RoutineError extends Error {}

const text = (value: unknown, name: string, maximum: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new RoutineError(`${name} must be 1 to ${maximum} characters`);
  return value.trim();
};

export function parseSchedule(value: unknown): RoutineSchedule {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const time = input.time;
  if (typeof time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new RoutineError('schedule.time must be HH:MM, 24-hour');
  switch (input.kind) {
    case 'daily': case 'weekdays': return {kind: input.kind, time};
    case 'weekly': {
      const days = input.days;
      if (!Array.isArray(days) || !days.length || !days.every(day => WEEKDAYS.includes(day))) {
        throw new RoutineError('schedule.days must list days such as "mon" or "sat"');
      }
      return {kind: 'weekly', time, days: WEEKDAYS.filter(day => days.includes(day))};
    }
    case 'monthly': {
      // Days 29 to 31 are missing from some months, so a monthly routine would silently skip them.
      if (!Number.isInteger(input.day) || (input.day as number) < 1 || (input.day as number) > 28) throw new RoutineError('schedule.day must be 1 to 28');
      return {kind: 'monthly', time, day: input.day as number};
    }
    case 'once': {
      const date = input.date;
      // Date.parse rolls a day the month does not have over into the next one (2026-02-31 is 3 March), so a real date is
      // one that reads back the same.
      if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))
        || new Date(date).toISOString().slice(0, 10) !== date) throw new RoutineError('schedule.date must be a real date, YYYY-MM-DD');
      return {kind: 'once', time, date};
    }
    default: throw new RoutineError('schedule.kind must be daily, weekdays, weekly, monthly or once');
  }
}

export function cronFor(schedule: RoutineSchedule): string {
  const [hour, minute] = schedule.time.split(':').map(Number);
  switch (schedule.kind) {
    case 'daily': return `${minute} ${hour} * * *`;
    case 'weekdays': return `${minute} ${hour} * * 1-5`;
    case 'weekly': return `${minute} ${hour} * * ${schedule.days.map(day => WEEKDAYS.indexOf(day)).join(',')}`;
    case 'monthly': return `${minute} ${hour} ${schedule.day} * *`;
    case 'once': return `${schedule.date}T${schedule.time}:00`;
  }
}

// Daylight saving is croner's: a time that does not exist that day (spring) runs an hour later, and a repeated one
// (autumn) runs once.
export function nextAfter(cron: string, from: Date): Date | null {
  return new Cron(cron, {timezone: TIME_ZONE, paused: true}).nextRun(from);
}

const ordinal = (day: number) => day + (day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th');

export function describeSchedule(schedule: RoutineSchedule): string {
  switch (schedule.kind) {
    case 'daily': return `Every day at ${schedule.time}`;
    case 'weekdays': return `Weekdays at ${schedule.time}`;
    case 'weekly': {
      const names = schedule.days.map(day => DAY_NAMES[WEEKDAYS.indexOf(day)]);
      return `${names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names.at(-1) : names[0]} at ${schedule.time}`;
    }
    case 'monthly': return `On the ${ordinal(schedule.day)} of each month at ${schedule.time}`;
    case 'once': return `Once, ${dateLabel(new Date(`${schedule.date}T12:00:00Z`))} at ${schedule.time}`;
  }
}

const zoned = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', {timeZone: TIME_ZONE, ...options});
const calendarDay = (date: Date) => Date.parse(zoned({year: 'numeric', month: '2-digit', day: '2-digit'}).format(date).split('/').reverse().join('-'));
const dateLabel = (date: Date) => zoned({weekday: 'long', day: 'numeric', month: 'long'}).format(date);
const clock = (date: Date) => zoned({hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(date);

// "Today 07:30", "Tomorrow 07:30", "Friday 07:30" within the week, then "Monday 3 November 07:30".
export function whenLabel(date: Date, now = new Date()): string {
  const time = clock(date);
  const days = Math.round((calendarDay(date) - calendarDay(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${zoned({weekday: 'long'}).format(date)} ${time}`;
  return `${dateLabel(date)} ${time}`;
}

// For a run's message: "Friday 17 October, 07:30".
export const runLabel = (date: Date) => `${dateLabel(date)}, ${clock(date)}`;

export const nextLabel = (routine: Routine, now = new Date()) =>
  !routine.nextRun ? 'Done' : !routine.enabled ? 'Paused' : whenLabel(new Date(routine.nextRun), now);

// `due` gets each routine whose time has come; `late` is set when the run was missed by more than MISSED_GRACE_MS.
// It is called once the routine's next run has moved on and the due run is saved as `pending`; started() or finished()
// clears that.
export async function createRoutines(path: string, due: (routine: Routine, scheduled: Date, late: boolean) => void) {
  let routines = await readJson<Routine[]>(path) ?? [];
  const save = serialSave(path, () => routines);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  // One timer for the earliest next run. setTimeout holds at most about 24 days, so a later run re-arms on the way.
  function arm() {
    clearTimeout(timer);
    if (stopped) return;
    const times = routines.filter(routine => routine.enabled && routine.nextRun).map(routine => Date.parse(routine.nextRun!));
    if (!times.length) return;
    timer = setTimeout(() => { void fire(); }, Math.min(Math.max(0, Math.min(...times) - Date.now()), 2 ** 31 - 1));
    timer.unref();
  }

  async function fire() {
    const now = new Date();
    const ready = routines.filter(routine => routine.enabled && routine.nextRun && Date.parse(routine.nextRun) <= now.getTime());
    const runs = ready.map(routine => {
      const scheduled = new Date(routine.nextRun!);
      routine.nextRun = nextAfter(routine.cron, now)?.toISOString() ?? null;
      // A run still waiting from before is overtaken by this one: one result per routine is enough.
      routine.pending = scheduled.toISOString();
      return {routine, scheduled, late: now.getTime() - scheduled.getTime() > MISSED_GRACE_MS};
    });
    try { if (runs.length) await save(); }
    catch { console.warn('Could not save routines; their runs wait for the next start'); return; }
    finally { arm(); }
    for (const {routine, scheduled, late} of runs) due(routine, scheduled, late);
  }

  const mine = (owner: User, id: unknown) => {
    const routine = routines.find(item => item.id === id && item.owner === owner);
    if (!routine) throw new RoutineError('No routine with that id; list the routines first');
    return routine;
  };
  // Every change is saved before it counts, and re-arms the timer.
  const commit = async () => { await save(); arm(); };

  return {
    // At startup, once the server can run them: runs that were waiting go back in line, then missed runs come due.
    // Returns the routines whose run the app stopped in the middle of, now recorded as failed.
    start(): Routine[] {
      const now = Date.now();
      const interrupted = routines.filter(routine => routine.lastRun?.outcome === 'running');
      for (const routine of interrupted) routine.lastRun = {...routine.lastRun!, outcome: 'failed'};
      if (interrupted.length) save().catch(() => console.warn('Could not save routines'));
      for (const routine of routines.filter(item => item.pending && !(item.nextRun && Date.parse(item.nextRun) <= now))) {
        const scheduled = new Date(routine.pending!);
        due(routine, scheduled, now - scheduled.getTime() > MISSED_GRACE_MS);
      }
      void fire();
      return interrupted;
    },
    stop: () => { stopped = true; clearTimeout(timer); },
    list: (owner: User) => routines.filter(routine => routine.owner === owner),
    byChat: (chat: string) => routines.find(routine => routine.chat === chat),
    get: (id: string) => routines.find(routine => routine.id === id),
    // Checks everything before the server makes the routine's conversation; `create` then saves it.
    prepare(owner: User, input: RoutineInput, now = new Date()) {
      if (routines.filter(routine => routine.owner === owner).length >= MAX_ROUTINES) {
        throw new RoutineError(`There can be at most ${MAX_ROUTINES} routines per person; delete one first`);
      }
      const schedule = parseSchedule(input.schedule);
      const cron = cronFor(schedule);
      const next = nextAfter(cron, now);
      if (!next) throw new RoutineError('That time has already passed');
      if (input.deepResearch !== undefined && typeof input.deepResearch !== 'boolean') throw new RoutineError('deepResearch must be true or false');
      return {
        id: randomUUID(), owner, title: text(input.title, 'title', MAX_ROUTINE_TITLE), prompt: text(input.prompt, 'prompt', MAX_ROUTINE_PROMPT), schedule, cron,
        enabled: true, deepResearch: input.deepResearch === true, nextRun: next.toISOString(),
      };
    },
    async create(routine: Omit<Routine, 'chat'>, chat: string): Promise<Routine> {
      const created = {...routine, chat};
      routines.push(created);
      await commit();
      return created;
    },
    async update(owner: User, id: unknown, input: RoutineInput, now = new Date()): Promise<Routine> {
      const routine = mine(owner, id);
      const changed = {...routine};
      if (input.title !== undefined) changed.title = text(input.title, 'title', MAX_ROUTINE_TITLE);
      if (input.prompt !== undefined) changed.prompt = text(input.prompt, 'prompt', MAX_ROUTINE_PROMPT);
      if (input.deepResearch !== undefined) {
        if (typeof input.deepResearch !== 'boolean') throw new RoutineError('deepResearch must be true or false');
        changed.deepResearch = input.deepResearch;
      }
      if (input.schedule !== undefined) {
        changed.schedule = parseSchedule(input.schedule);
        changed.cron = cronFor(changed.schedule);
        const next = nextAfter(changed.cron, now);
        if (!next) throw new RoutineError('That time has already passed');
        changed.nextRun = next.toISOString();
      }
      Object.assign(routine, changed);
      await commit();
      return routine;
    },
    async setEnabled(owner: User, id: unknown, enabled: boolean, now = new Date()): Promise<Routine> {
      const routine = mine(owner, id);
      if (enabled && !routine.nextRun) throw new RoutineError('This one-off routine has already run; give it a new date to use it again');
      routine.enabled = enabled;
      // Resuming starts from now, so the runs missed while it was paused are not made up.
      if (enabled) routine.nextRun = nextAfter(routine.cron, now)?.toISOString() ?? null;
      await commit();
      return routine;
    },
    async remove(owner: User, id: unknown): Promise<Routine> {
      const routine = mine(owner, id);
      routines = routines.filter(item => item !== routine);
      await commit();
      return routine;
    },
    // `at` is the run's scheduled time, which tells it apart from a newer run of the same routine waiting meanwhile.
    async started(routine: Routine, at: Date) {
      if (!routines.includes(routine)) return;
      if (routine.pending === at.toISOString()) delete routine.pending;
      routine.lastRun = {at: at.toISOString(), outcome: 'running'};
      await commit();
    },
    async finished(routine: Routine, at: Date, outcome: 'done' | 'failed' | 'skipped') {
      if (!routines.includes(routine)) return;
      if (routine.pending === at.toISOString()) delete routine.pending;
      routine.lastRun = {at: at.toISOString(), outcome};
      // A one-off is done once its run is, and no newer one waits.
      if (!routine.nextRun && !routine.pending) routine.enabled = false;
      await commit();
    },
  };
}
