// Pure HTML renderer for the `.eventSchedule` editor.
//
// Mirrors the structure used by the sync feature's pure renderers
// (configEditorHtml, adminEditorHtml, manifestEditorHtml): take a fully-
// resolved view model, return a string, never import vscode.
//
// Two hosts consume this: the VS Code custom editor (eventEditor.ts) renders
// the default `'webview'` document (CSP + nonce'd inline script that posts
// typed action messages back to the wired layer); the PWA renders the
// `host:'dom'` script-free fragment into a shadow root and re-wires the
// interactions as direct DOM (pptx-distro-kit src/views/eventEditor.ts).
//
// Sections:
//   - Parse-error banner (when present)
//   - Event header (name + days)
//   - Speakers list
//   - Rooms list
//   - Sessions grid (day rows × timeslot rows × room columns)
//   - Vacancies (read-only derived list)
//   - Tools — Regenerate from config (visible only on placeholder files)
//
// The view state lives entirely in the DOM; the host re-renders the full body
// on every mutation. No client-side framework.

import type {
  EventConfig,
  EventRoom,
  EventSchedule,
  EventSession,
  EventSpeaker,
  EventVacancy,
} from './schedule';
import {
  displayTitleForSession,
  eligibleSpeakersForSession,
  resolveLayout,
  timeslotsForDayResolved,
} from './scheduleData';

/**
 * Fully-resolved view model for the event editor. Pure data — no vscode types.
 * Both hosts build it: the VS Code custom editor (eventEditor.ts) and the PWA
 * shadow-root view (pptx-distro-kit src/views/eventEditor.ts).
 */
export interface EventEditorViewModel {
  schedule: EventSchedule;
  parseErrors: string[];
  /** True when the document text is empty (whitespace-only). */
  isEmpty: boolean;
  /**
   * True when the file is safe to overwrite via "Generate sample schedule" —
   * either the file is empty, its sha256 is in the active placeholder registry,
   * or it's structurally empty. Drives that button's visibility.
   */
  isPlaceholder: boolean;
}

/** Render options. `host:'dom'` returns a script-free, CSP-free fragment for a
 *  single-document host (the PWA) to splice into a shadow root — mirroring the
 *  `host:'dom'` mode `webview.ts` / `searchPanelHtml.ts` grew for the PWA. The
 *  default `'webview'` mode is unchanged (full document + nonce'd script). */
export interface EventEditorRenderOptions {
  host?: 'webview' | 'dom';
}

export function renderEventEditorHtml(
  vm: EventEditorViewModel,
  nonce: string,
  opts?: EventEditorRenderOptions,
): string {
  const css = pageCss();
  if (opts?.host === 'dom') {
    // Script-free fragment. Same `#root` element + ids/classes as the webview
    // body so pageCss() styles it identically and the PWA twin can re-wire the
    // interactions (the inline script's `acquireVsCodeApi` bridge has no
    // analogue in a single-document host).
    return `<style>${css}</style>
<main id="root">${renderBody(vm)}</main>`;
  }
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Event Schedule</title>
<style>${css}</style>
</head>
<body>
  <main id="root">${renderBody(vm)}</main>
  <script nonce="${nonce}">${clientScript()}</script>
</body>
</html>`;
}

// Exported for tests + the wired layer's "docChanged" reply path so a
// partial re-render is cheap.
export function renderBody(vm: EventEditorViewModel): string {
  return [
    renderParseBanner(vm.parseErrors),
    renderHeader(vm.schedule),
    renderSpeakers(vm.schedule),
    renderRooms(vm.schedule),
    renderSessionsGrid(vm.schedule),
    renderVacancies(vm.schedule),
    renderTools(vm),
  ].join('\n');
}

function renderParseBanner(errors: readonly string[]): string {
  if (errors.length === 0) return '';
  const lis = errors.map((e) => `<li>${escapeHtml(e)}</li>`).join('');
  return `<section class="banner banner-warn">
    <strong>Parse warnings</strong>
    <ul>${lis}</ul>
    <p>The editor falls back to defaults for any field it couldn't read. Save to rewrite the file cleanly.</p>
  </section>`;
}

function renderHeader(s: EventSchedule): string {
  const defaults = s.config.defaultTimeslots;
  const defaultsValue = Array.isArray(defaults) ? defaults.join(', ') : '';
  return `<header class="evt-head">
    <h1>Event schedule</h1>
    <div class="evt-row">
      <label class="evt-field">
        <span>Event name</span>
        <input type="text" id="event-name" value="${escapeAttr(s.config.name)}" autocomplete="off">
      </label>
    </div>
    <div class="evt-row">
      <label class="evt-field">
        <span>Days (comma-separated, in order)</span>
        <input type="text" id="event-days" value="${escapeAttr(s.config.days.join(', '))}" autocomplete="off" placeholder="MON, TUE, WED">
      </label>
    </div>
    <div class="evt-row">
      <label class="evt-field">
        <span>Default timeslot labels for new days <span class="muted">(comma-separated, optional)</span></span>
        <div class="evt-field-with-action">
          <input type="text" id="event-default-timeslots" value="${escapeAttr(defaultsValue)}" autocomplete="off" placeholder="A, B, C, D">
          <button type="button" class="btn btn-sm" id="apply-defaults-btn"${defaultsValue ? '' : ' disabled'} title="Apply these labels positionally to every existing day — renames the slots, doesn't drop any sessions">Apply to all</button>
        </div>
      </label>
    </div>
  </header>`;
}

function renderSpeakers(s: EventSchedule): string {
  const rows = s.speakers.length === 0
    ? `<li class="empty">No speakers yet. Add the first one below.</li>`
    : s.speakers
        .map(
          (sp) => `
        <li class="evt-list-row" data-speaker-id="${escapeAttr(sp.id)}">
          <span class="evt-list-id">${escapeHtml(sp.id)}</span>
          <input class="evt-list-name" type="text" data-rename-speaker="${escapeAttr(sp.id)}" value="${escapeAttr(sp.name)}" autocomplete="off">
          <button type="button" class="btn btn-sm btn-danger" data-remove-speaker="${escapeAttr(sp.id)}" title="Remove this speaker (also drops them from every session)">Remove</button>
        </li>`,
        )
        .join('');
  return `<section class="evt-section">
    <h2>Speakers <span class="evt-count">${s.speakers.length}</span></h2>
    <ul class="evt-list" id="speakers-list">${rows}</ul>
    <div class="evt-add-row">
      <input type="text" id="add-speaker-name" placeholder="New speaker name" autocomplete="off">
      <button type="button" class="btn" id="add-speaker-btn">+ Add speaker</button>
    </div>
  </section>`;
}

function renderRooms(s: EventSchedule): string {
  const rows = s.rooms.length === 0
    ? `<li class="empty">No rooms yet. Add the first one below.</li>`
    : s.rooms
        .map(
          (r) => `
        <li class="evt-list-row" data-room-id="${escapeAttr(r.id)}">
          <span class="evt-list-id">${escapeHtml(r.id)}</span>
          <input class="evt-list-name" type="text" data-rename-room="${escapeAttr(r.id)}" value="${escapeAttr(r.name)}" autocomplete="off">
          <span class="evt-room-kind kind-${escapeAttr(r.kind)}" title="Room kind">${escapeHtml(r.kind)}</span>
          <button type="button" class="btn btn-sm btn-danger" data-remove-room="${escapeAttr(r.id)}" title="Remove this room (also drops every session hosted there)">Remove</button>
        </li>`,
        )
        .join('');
  return `<section class="evt-section">
    <h2>Rooms <span class="evt-count">${s.rooms.length}</span></h2>
    <ul class="evt-list" id="rooms-list">${rows}</ul>
    <div class="evt-add-row">
      <input type="text" id="add-room-name" placeholder="New room name" autocomplete="off">
      <select id="add-room-kind">
        <option value="breakout" selected>breakout</option>
        <option value="plenary">plenary</option>
      </select>
      <button type="button" class="btn" id="add-room-btn">+ Add room</button>
    </div>
  </section>`;
}

function renderSessionsGrid(s: EventSchedule): string {
  if (s.rooms.length === 0 || s.config.days.length === 0) {
    return `<section class="evt-section">
      <h2>Sessions</h2>
      <p class="hint">Add at least one room and one day to start scheduling sessions.</p>
    </section>`;
  }
  // M1: each day reads its own ordered slot list via timeslotsForDayResolved.
  // The grid renderer iterates per-day rather than over a single union — see
  // M4 for the row-level UX (rename / reorder / add / delete affordances).
  // index sessions by (day, timeslot, roomId) → session
  const sessionAt = new Map<string, EventSession>();
  for (const sess of s.sessions) {
    sessionAt.set(`${sess.day}::${sess.timeslot}::${sess.roomId}`, sess);
  }
  const speakerById = new Map(s.speakers.map((sp) => [sp.id, sp]));
  const dayBlocks = s.config.days
    .map((day) => renderDayBlock(s, day, timeslotsForDayResolved(s, day), sessionAt, speakerById))
    .join('\n');
  return `<section class="evt-section">
    <h2>Sessions <span class="evt-count">${s.sessions.length}</span></h2>
    <p class="hint">Click a cell to edit. Empty cells show <code>+</code> — click to schedule a session there.</p>
    ${dayBlocks}
  </section>`;
}

function renderDayBlock(
  s: EventSchedule,
  day: string,
  timeslots: readonly string[],
  sessionAt: ReadonlyMap<string, EventSession>,
  speakerById: ReadonlyMap<string, EventSpeaker>,
): string {
  const headerCells = s.rooms
    .map((r) => `<th><span class="room-name">${escapeHtml(r.name)}</span> <span class="room-id">${escapeHtml(r.id)}</span></th>`)
    .join('');
  // `data-row-first` / `data-row-last` are read by CSS to hide the up/down
  // affordances at the edges of the day's row stack (a CSS-only edge guard
  // is cleaner than asking the client script to inspect siblings before
  // posting a swap).
  const rows = timeslots
    .map((timeslot, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === timeslots.length - 1;
      const cells = s.rooms
        .map((room) => {
          const sess = sessionAt.get(`${day}::${timeslot}::${room.id}`);
          return renderCell(s, sess, day, timeslot, room, speakerById);
        })
        .join('');
      const flags = `${isFirst ? ' data-row-first' : ''}${isLast ? ' data-row-last' : ''}`;
      return `<tr class="ts-row" data-day="${escapeAttr(day)}" data-ts-label="${escapeAttr(timeslot)}"${flags}>${renderTimeslotHeader(day, timeslot)}${cells}</tr>`;
    })
    .join('');
  // Spanning column count for the add-row: timeslot header + one column per
  // room. The colspan keeps the cell at full-width regardless of room count.
  const addRowSpan = s.rooms.length + 1;
  const addRow = `<tr class="ts-add-row"><td colspan="${addRowSpan}">
    <button type="button" class="btn-add-ts" data-add-ts="${escapeAttr(day)}" title="Append a new timeslot to ${escapeAttr(day)}">+ Add timeslot to ${escapeHtml(day)}</button>
  </td></tr>`;
  return `<div class="day-block">
    <h3>${escapeHtml(day)}</h3>
    <table class="sessions-grid">
      <thead><tr><th class="ts">Time</th>${headerCells}</tr></thead>
      <tbody>${rows}${addRow}</tbody>
    </table>
  </div>`;
}

// Row-header cell for a timeslot. Surface includes:
//   - inline rename input (looks borderless until focused — see CSS)
//   - ▲ / ▼ to reorder the day's rows (hidden at edges via data-row-first /
//     data-row-last on the <tr>; revealed on row-hover via CSS)
//   - ✕ to remove the timeslot (hover-revealed)
function renderTimeslotHeader(day: string, label: string): string {
  return `<th class="ts">
    <div class="ts-cell">
      <button type="button" class="ts-up" data-reorder-ts-up="${escapeAttr(day)}::${escapeAttr(label)}" title="Move ${escapeAttr(label)} up" aria-label="Move ${escapeAttr(label)} up">▲</button>
      <input type="text" class="ts-label" data-rename-ts-day="${escapeAttr(day)}" data-rename-ts-old="${escapeAttr(label)}" value="${escapeAttr(label)}" spellcheck="false" autocomplete="off" aria-label="Rename timeslot ${escapeAttr(label)}">
      <button type="button" class="ts-down" data-reorder-ts-down="${escapeAttr(day)}::${escapeAttr(label)}" title="Move ${escapeAttr(label)} down" aria-label="Move ${escapeAttr(label)} down">▼</button>
      <button type="button" class="ts-remove" data-remove-ts="${escapeAttr(day)}::${escapeAttr(label)}" title="Remove timeslot ${escapeAttr(label)} from ${escapeAttr(day)}" aria-label="Remove timeslot">✕</button>
    </div>
  </th>`;
}

function renderCell(
  s: EventSchedule,
  sess: EventSession | undefined,
  day: string,
  timeslot: string,
  room: EventRoom,
  speakerById: ReadonlyMap<string, EventSpeaker>,
): string {
  if (!sess) {
    return `<td class="cell cell-empty" data-day="${escapeAttr(day)}" data-ts="${escapeAttr(timeslot)}" data-room="${escapeAttr(room.id)}">
      <button type="button" class="cell-add" data-add-session="${escapeAttr(`${day}::${timeslot}::${room.id}`)}" title="Add a session at ${escapeAttr(day)} ${escapeAttr(timeslot)} in ${escapeAttr(room.name)}">+</button>
    </td>`;
  }
  const speakerList = sess.speakers.length === 0
    ? '<em class="muted">no speakers</em>'
    : sess.speakers
        .map((sl) => {
          const sp = speakerById.get(sl.speakerId);
          const name = sp ? sp.name : sl.speakerName;
          return `<li>${escapeHtml(name)} <span class="muted">(${escapeHtml(sl.speakerId)})</span></li>`;
        })
        .join('');
  // Title line: real authored title renders in normal weight; the
  // `kind`-fallback renders muted-italic so the user can tell at a glance
  // whether a session has been titled or is showing its placeholder.
  const titleText = displayTitleForSession(sess);
  const titleIsFallback = !sess.title?.trim();
  const titleClass = titleIsFallback ? 'session-title session-title-default' : 'session-title session-title-set';
  // Hover-revealed swap arrows: ▲ swaps this session with the prev
  // timeslot in this same room, ▼ with the next. CSS hides the arrows
  // entirely on rows tagged `data-row-first` / `data-row-last` (see
  // renderDayBlock), so we don't need to gate them here.
  return `<td class="cell cell-filled" data-day="${escapeAttr(day)}" data-ts="${escapeAttr(timeslot)}" data-room="${escapeAttr(room.id)}" data-session-id="${escapeAttr(sess.id)}">
    <button type="button" class="cell-swap-up" data-swap-up="${escapeAttr(sess.id)}" title="Swap with the session above in ${escapeAttr(room.name)}" aria-label="Swap up">▲</button>
    <button type="button" class="cell-swap-down" data-swap-down="${escapeAttr(sess.id)}" title="Swap with the session below in ${escapeAttr(room.name)}" aria-label="Swap down">▼</button>
    <details class="session-edit" name="event-session-edit-group">
      <summary>
        <span class="${titleClass}">${escapeHtml(titleText)}</span>
        <ul class="speaker-pills">${speakerList}</ul>
      </summary>
      <div class="session-edit-body">
        ${renderSessionEditForm(s, sess, speakerById)}
      </div>
    </details>
  </td>`;
}

function renderSessionEditForm(
  s: EventSchedule,
  sess: EventSession,
  speakerById: ReadonlyMap<string, EventSpeaker>,
): string {
  // Chips for currently-assigned speakers. Each chip carries the speaker id
  // in `data-speaker-id`; the chip-row container carries the session id so
  // the delegated click + drag handlers can post `setSessionSpeakers` with
  // the right session. Empty roster shows a muted hint.
  const chips = sess.speakers.length === 0
    ? '<span class="chip-row-empty">No speakers — click + to add.</span>'
    : sess.speakers
        .map((sl) => {
          const sp = speakerById.get(sl.speakerId);
          const name = sp ? sp.name : sl.speakerName;
          return `<span class="chip" draggable="true" data-speaker-id="${escapeAttr(sl.speakerId)}" title="Drag to reorder">
            <span class="chip-name">${escapeHtml(name)}</span>
            <button type="button" class="chip-remove" data-chip-remove="${escapeAttr(sl.speakerId)}" title="Remove ${escapeAttr(name)} from this session" aria-label="Remove ${escapeAttr(name)}">×</button>
          </span>`;
        })
        .join('');

  // Eligible speakers — those not in any other session sharing (day, timeslot).
  // The current session's own speakers stay eligible by design, but we filter
  // them out for the Add popover (no point offering an already-added speaker).
  const eligibleIds = eligibleSpeakersForSession(s, sess.day, sess.timeslot, sess.id);
  const assigned = new Set(sess.speakers.map((sl) => sl.speakerId));
  const popoverOptions = eligibleIds
    .filter((id) => !assigned.has(id))
    .map((id) => {
      const sp = speakerById.get(id);
      if (!sp) return '';
      return `<li class="picker-row" data-picker-speaker-id="${escapeAttr(sp.id)}" data-search="${escapeAttr(sp.name.toLowerCase())}">
        <span class="picker-name">${escapeHtml(sp.name)}</span>
        <span class="picker-id">${escapeHtml(sp.id)}</span>
      </li>`;
    })
    .filter((s2) => s2 !== '')
    .join('');
  const popoverEmpty = popoverOptions === '';

  // Title input — free-form, optional. Placeholder shows the session
  // `kind` so the user can see what the cell summary would fall back to
  // when the title is empty. Empty input (post-trim) clears the field
  // and the marshaler strips it from the file.
  return `<div class="evt-row">
    <label class="evt-field">
      <span>Title <span class="muted">(optional)</span></span>
      <input type="text" data-session-title="${escapeAttr(sess.id)}" value="${escapeAttr(sess.title ?? '')}" placeholder="${escapeAttr(sess.kind)}" autocomplete="off">
    </label>
  </div>
  <div class="evt-field">
    <span class="evt-field-label">Speakers <span class="muted">(drag to reorder)</span></span>
    <div class="chip-row" data-session-id="${escapeAttr(sess.id)}">
      ${chips}
      <button type="button" class="chip-add" data-chip-add-for="${escapeAttr(sess.id)}" title="Add a speaker">+</button>
    </div>
    <div class="speaker-picker" data-speaker-picker-for="${escapeAttr(sess.id)}" hidden>
      <input type="text" class="picker-filter" data-picker-filter-for="${escapeAttr(sess.id)}" placeholder="Type to filter…" autocomplete="off">
      <ul class="picker-list" data-picker-list-for="${escapeAttr(sess.id)}">
        ${popoverEmpty ? '<li class="picker-empty">All eligible speakers are already assigned, or every speaker is busy in this timeslot.</li>' : popoverOptions}
      </ul>
    </div>
  </div>
  <div class="evt-row">
    <button type="button" class="btn btn-sm btn-danger" data-remove-session="${escapeAttr(sess.id)}">Remove session</button>
  </div>`;
}

function renderVacancies(s: EventSchedule): string {
  if (s.vacancies.length === 0) return '';
  const rows = s.vacancies
    .map(
      (v: EventVacancy) => `<li>
        <span class="muted">${escapeHtml(v.day)} · ${escapeHtml(v.timeslot)} · ${escapeHtml(v.roomId)}</span>
        — ${escapeHtml(v.reason)}
      </li>`,
    )
    .join('');
  return `<section class="evt-section">
    <h2>Vacancies <span class="evt-count">${s.vacancies.length}</span></h2>
    <p class="hint">Breakout rooms emptied by relocations. Derived; edit by reassigning the relocated session.</p>
    <ul class="evt-list-plain">${rows}</ul>
  </section>`;
}

function renderTools(vm: EventEditorViewModel): string {
  // Tools section. Clear sits at the top in BOTH branches — the user uses
  // it to MAKE a file a placeholder, so gating it on placeholder status
  // would make the action unreachable on the files that most need it.
  // Regenerate stays gated (only safe on placeholder files; the wired
  // layer also enforces via sha-against-placeholder-registry).
  const clearBtn = `<button type="button" class="btn btn-danger" id="clear-all-btn" title="Wipe speakers, rooms, and sessions. Keeps the event name, days, and timeslot labels.">Clear</button>`;
  const toolsHeader = `<div class="evt-tools-header">
    <h2>Tools</h2>
    ${clearBtn}
  </div>`;
  if (!vm.isPlaceholder) {
    const layout = resolveLayout(vm.schedule);
    return `<section class="evt-section evt-tools">
      ${toolsHeader}
      <p class="evt-tools-layout">
        <label for="event-layout"><strong>Folder layout:</strong></label>
        <select id="event-layout">
          <option value="day-major"${layout === 'day-major' ? ' selected' : ''}>Day-major — &lt;day&gt;/&lt;room&gt;/&lt;timeslot&gt;/</option>
          <option value="room-major"${layout === 'room-major' ? ' selected' : ''}>Room-major — &lt;room&gt;/&lt;day&gt;/&lt;timeslot&gt;/</option>
        </select>
        <span class="hint">Locked in here so both generators below stay consistent. Files land in the folder containing this <code>.eventSchedule</code>.</span>
      </p>
      <p class="hint">
        Generate folders writes a directory tree mirroring this schedule —
        one folder per (room, day, timeslot) with a zero-byte placeholder
        file per speaker slot. Existing <code>.roomSync</code> templates
        in the destination are preserved (your wiring isn't wiped); the
        speaker placeholders overwrite.
      </p>
      <p>
        <button type="button" class="btn" id="generate-folders-btn" title="Materialise the folder tree for this event into the folder containing this .eventSchedule.">Generate folders…</button>
        <button type="button" class="btn" id="bind-title-slides-btn" title="${escapeAttr(bindButtonTitle(vm))}">${
          vm.schedule.config.titleSlides
            ? 'Edit title-slide binding…'
            : 'Bind title-slide template…'
        }</button>
        <button type="button" class="btn" id="generate-title-slides-btn"${
          vm.schedule.config.titleSlides ? '' : ' disabled'
        } title="${escapeAttr(generateTitleButtonTitle(vm))}">Generate title slides…</button>
        <button type="button" class="btn btn-secondary" id="open-text-btn">Reopen as text</button>
      </p>
      <p class="hint">Generate sample schedule is only available on placeholder schedules. Clear the file first to enable.</p>
    </section>`;
  }
  const c = vm.schedule.config;
  return `<section class="evt-section evt-tools">
    ${toolsHeader}
    <details>
      <summary><span class="evt-tools-regen-label">Generate sample schedule from config</span></summary>
      <p class="hint">
        Fill these and press Generate. The file is rebuilt from scratch — speakers, rooms, and sessions are <strong>replaced</strong> with a freshly-randomised sample set (speaker names drawn from a fixed pool, breakouts assigned by seed). Available only because this file is currently empty or matches a placeholder hash. Use this to stub out test events; it does NOT re-emit anything from the data you've already entered.
      </p>
      <div class="evt-config-grid">
        ${configField('seed', 'Seed', c.seed)}
        ${configField('breakoutRoomCount', 'Breakout rooms', c.breakoutRoomCount)}
        ${configField('plenaryOpenSpeakers', 'Opening speakers', c.plenaryOpenSpeakers)}
        ${configField('closingSpeakers', 'Closing speakers', c.closingSpeakers)}
        ${configField('breakoutSessionsPerDay', 'Breakout sessions/day', c.breakoutSessionsPerDay)}
        ${configField('breakoutSessionsLastDay', 'Breakout sessions (last day)', c.breakoutSessionsLastDay)}
        ${configField('speakerPoolSize', 'Speaker pool size', c.speakerPoolSize)}
        ${configField('speakersPerBreakoutMin', 'Speakers / breakout (min)', c.speakersPerBreakoutMin)}
        ${configField('speakersPerBreakoutMax', 'Speakers / breakout (max)', c.speakersPerBreakoutMax)}
        ${configField('relocations', 'Relocations', c.relocations)}
      </div>
      <p>
        <button type="button" class="btn btn-warn" id="regenerate-btn" title="Run the random-data generator and replace this file's contents with sample data">Generate</button>
        <button type="button" class="btn btn-secondary" id="open-text-btn">Reopen as text</button>
      </p>
    </details>
  </section>`;
}

function bindButtonTitle(vm: EventEditorViewModel): string {
  const ts = vm.schedule.config.titleSlides;
  if (!ts) {
    return 'Pick a .pptx template and assign roles to its text frames. Generates one title deck per (room, day) at generate time.';
  }
  return `Currently bound to ${ts.templatePath}. Click to re-bind or change template.`;
}

function generateTitleButtonTitle(vm: EventEditorViewModel): string {
  const ts = vm.schedule.config.titleSlides;
  if (!ts) {
    return 'Bind a title-slide template first.';
  }
  return `Render one title deck per (room, day) using "${ts.templatePath}". Decks whose underlying data hasn't changed since the last run are skipped (fingerprint match).`;
}

function configField(key: keyof EventConfig, label: string, value: number): string {
  return `<label class="evt-field">
    <span>${escapeHtml(label)}</span>
    <input type="number" data-config-key="${escapeAttr(String(key))}" value="${escapeAttr(String(value))}" step="1" min="0">
  </label>`;
}

// ───── Client-side script ──────────────────────────────────────────────

function clientScript(): string {
  // Tiny event-delegation wiring. The extension re-renders the whole body
  // via `docChanged` after each mutation, so we don't keep client-side
  // state — every interaction posts a message and waits.
  return `(function(){
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    function post(msg){
      try { vscode.postMessage(msg); } catch (_) {}
    }

    // Replace the body's innerHTML whenever the wired layer pushes a fresh
    // render. Event handlers are delegated on the root element and attached
    // once at script-load time — they survive innerHTML swaps because the
    // root element itself isn't replaced, only its descendants.
    //
    // Preserve open <details> across the swap so a chip-drag or add-speaker
    // doesn't collapse the session editor the user is actively working in.
    // Snapshot the open set before the swap, re-apply after. We can't do a
    // targeted "only re-render this session" update because a speaker move
    // in one session changes the eligibility list of every OTHER session in
    // the same (day, timeslot) — a partial update would leave the sibling
    // pickers stale.
    //
    // The wired layer pushes on every successful own-write (with the next
    // schedule directly) AND on every onDidChangeTextDocument event (with
    // the parsed-from-doc view model). Both paths produce the same body
    // for a stable file state, so a double-fire is visually a no-op.
    window.addEventListener('message', function(e){
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'docChanged' && typeof m.html === 'string') {
        // Snapshot the panels the user has open BEFORE the swap so we can
        // re-open them after innerHTML replaces every descendant.
        const openSessionIds = [];
        const openSessions = root.querySelectorAll('td.cell-filled details.session-edit[open]');
        for (let i = 0; i < openSessions.length; i++) {
          const td = openSessions[i].closest('td.cell-filled');
          const sid = td ? td.getAttribute('data-session-id') : null;
          if (sid) openSessionIds.push(sid);
        }
        // Tools / regenerate section is a top-level <details> too.
        const toolsOpen = !!root.querySelector('section.evt-tools details[open]');

        // Snapshot the focused element's id so rapid-fire data entry
        // (type Alice⏎Bob⏎Carol⏎ into #add-speaker-name) stays in the
        // input across the post→re-render round-trip. Any input with a
        // stable id auto-restores; the speaker / room "add" inputs are
        // the ones that matter for rapid entry, and both carry an id.
        const ae = document.activeElement;
        const activeId = ae && ae.id && root.contains(ae) ? ae.id : null;

        root.innerHTML = m.html;

        // Re-open. closest() can't traverse from a fragment we just dropped
        // in, so query against the root.
        for (let i = 0; i < openSessionIds.length; i++) {
          const sid = openSessionIds[i];
          const td = root.querySelector('td.cell-filled[data-session-id="' + cssEscape(sid) + '"]');
          if (!td) continue;
          const details = td.querySelector('details.session-edit');
          if (details) details.open = true;
        }
        if (toolsOpen) {
          const toolsDetails = root.querySelector('section.evt-tools details');
          if (toolsDetails) toolsDetails.open = true;
        }

        // Restore focus. The new element with the captured id is a
        // freshly-rendered DOM node, so we query the post-swap root
        // rather than retaining the pre-swap reference.
        if (activeId) {
          const el = document.getElementById(activeId);
          if (el && typeof el.focus === 'function') {
            try { el.focus(); } catch (_) {}
          }
        }
      }
    });

    // Read the current speaker order out of a chip-row's DOM. Used after
    // a remove or a drag-drop to compute the new order to post.
    function chipRowOrder(sessionId){
      const row = root.querySelector('.chip-row[data-session-id="' + cssEscape(sessionId) + '"]');
      if (!row) return [];
      const chips = row.querySelectorAll('.chip[data-speaker-id]');
      const out = [];
      for (let i = 0; i < chips.length; i++) {
        const id = chips[i].getAttribute('data-speaker-id');
        if (id) out.push(id);
      }
      return out;
    }

    // CSS.escape isn't on older webview surfaces — minimal shim that
    // handles the speaker / session id shapes we actually emit (alnum +
    // dashes + hyphens). Anything more exotic isn't expected here.
    function cssEscape(s){
      return String(s).replace(/[^a-zA-Z0-9_-]/g, function(c){ return '\\\\' + c; });
    }

    // Day's current ordered timeslot labels, read from the DOM. The
    // renderer stamps each <tr class="ts-row"> with data-day + data-ts-label,
    // in display order; reading from the DOM means we always operate on
    // the current state without re-deriving the schedule client-side.
    // Used by reorderTimeslots (compute new order from a swap-by-index)
    // and by swapSessionsInRoom (find neighbour label).
    function timeslotsForDay(day){
      const rows = root.querySelectorAll('tr.ts-row[data-day="' + cssEscape(day) + '"]');
      const out = [];
      for (let i = 0; i < rows.length; i++) {
        const lbl = rows[i].getAttribute('data-ts-label');
        if (lbl) out.push(lbl);
      }
      return out;
    }

    // Local mirror of isValidTimeslotLabel — rejects the same set of
    // filename-hostile characters so the user gets immediate red-border
    // feedback as they type, rather than waiting for the wired layer to
    // refuse silently. Keep in sync with src/event/scheduleData.ts.
    function isValidLabel(s){
      if (typeof s !== 'string') return false;
      if (s.length === 0) return false;
      if (s !== s.trim()) return false;
      return !/[\\\\/:*?"<>|]/.test(s);
    }

    // Event header
    root.addEventListener('change', function(e){
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'event-name') {
        post({ type: 'setEventName', name: t.value });
      } else if (t.id === 'event-days') {
        const days = t.value.split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
        post({ type: 'setDays', days: days });
      } else if (t.id === 'event-default-timeslots') {
        const labels = t.value.split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
        post({ type: 'setDefaultTimeslots', labels: labels });
      } else if (t.id === 'event-layout') {
        post({ type: 'setLayout', layout: t.value });
      }
    });

    // Speaker / room / session-title rename + timeslot rename via blur.
    // The timeslot rename has an extra step: local validation matches the
    // wired-layer mirror, so an invalid label reverts in-place rather
    // than firing a no-op round-trip. Live red-border feedback during
    // typing comes from the input handler below.
    root.addEventListener('blur', function(e){
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.renameSpeaker) {
        post({ type: 'renameSpeaker', speakerId: t.dataset.renameSpeaker, name: t.value });
      } else if (t.dataset.renameRoom) {
        post({ type: 'renameRoom', roomId: t.dataset.renameRoom, name: t.value });
      } else if (t.dataset.sessionTitle) {
        post({ type: 'setSessionTitle', sessionId: t.dataset.sessionTitle, title: t.value });
      } else if (t.dataset.renameTsDay) {
        const day = t.dataset.renameTsDay;
        const oldLabel = t.dataset.renameTsOld;
        const newLabel = t.value;
        if (oldLabel === newLabel) return;
        if (!isValidLabel(newLabel)) {
          // Revert to the previous label and clear the red-border state
          // — the user already saw it during typing.
          t.value = oldLabel;
          t.classList.remove('ts-label-invalid');
          return;
        }
        t.classList.remove('ts-label-invalid');
        post({ type: 'renameTimeslot', day: day, oldLabel: oldLabel, newLabel: newLabel });
      }
    }, true);

    // Speaker-picker filter + live timeslot-label validation.
    root.addEventListener('input', function(e){
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.pickerFilterFor) {
        const sessionId = t.dataset.pickerFilterFor;
        const list = root.querySelector('.picker-list[data-picker-list-for="' + cssEscape(sessionId) + '"]');
        if (!list) return;
        const q = String(t.value || '').trim().toLowerCase();
        const rows = list.querySelectorAll('.picker-row');
        for (let i = 0; i < rows.length; i++) {
          const search = rows[i].getAttribute('data-search') || '';
          rows[i].hidden = q !== '' && search.indexOf(q) === -1;
        }
        return;
      }
      if (t.dataset.renameTsDay) {
        // Live filename-safe validation. Allow an empty intermediate
        // state without flagging — the user is mid-type. The blur path
        // catches truly empty submissions and reverts.
        if (t.value === '' || isValidLabel(t.value)) {
          t.classList.remove('ts-label-invalid');
        } else {
          t.classList.add('ts-label-invalid');
        }
      }
    });

    // Enter-to-submit on the speaker / room "add" inputs. Pressing
    // Enter is equivalent to clicking the + Add button — lets the user
    // type "Alice"⏎"Bob"⏎"Carol"⏎ without touching the mouse.
    root.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      const t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'add-speaker-name') {
        e.preventDefault();
        const name = (t.value || '').trim();
        if (!name) return;
        post({ type: 'addSpeaker', name: name });
        t.value = '';
        return;
      }
      if (t.id === 'add-room-name') {
        e.preventDefault();
        const name = (t.value || '').trim();
        if (!name) return;
        const kindEl = document.getElementById('add-room-kind');
        const kind = (kindEl && (kindEl.value === 'plenary' || kindEl.value === 'breakout')) ? kindEl.value : 'breakout';
        post({ type: 'addRoom', name: name, kind: kind });
        t.value = '';
        return;
      }
    });

    // Paste-multiline into the "add" inputs. A clipboard payload with
    // newlines (e.g. an Excel column or a list pasted from a text
    // editor) gets split into one entry per line and shipped as a
    // single bulk message — addSpeakers / addRooms. Bulk avoids racing
    // the wired layer's parse→write→refresh cycle, which N back-to-
    // back single-add posts would lose entries to.
    //
    // Single-line pastes (no newline in the clipboard) fall through to
    // the browser's default — the text fills the input as usual and
    // the user presses Enter / clicks Add to commit.
    root.addEventListener('paste', function(e){
      const t = e.target;
      if (!t) return;
      // Identify which paste target this is. Add inputs key on id; the
      // speaker-picker filter input lives inside the session edit panel
      // and identifies its session via data-picker-filter-for. Anything
      // else falls through to default browser paste.
      const isSpeakerInput = t.id === 'add-speaker-name';
      const isRoomInput = t.id === 'add-room-name';
      const pickerSessionId = (t.dataset && t.dataset.pickerFilterFor) || '';
      if (!isSpeakerInput && !isRoomInput && !pickerSessionId) return;

      const clipboard = e.clipboardData;
      if (!clipboard) return;
      const text = clipboard.getData('text/plain');
      if (!text) return;
      // Only intercept multi-line content. CRLF, LF, and bare CR all
      // get treated as line breaks (Excel-on-Windows and macOS text
      // editors disagree about which one to emit). The \\n / \\r in
      // this template-literal source emit as the JS escape sequence
      // \\n / \\r in the output script — writing a literal \\n here
      // would interpolate to a raw newline character, which would
      // then break the emitted string / regex literal at runtime.
      if (text.indexOf('\\n') === -1 && text.indexOf('\\r') === -1) return;
      e.preventDefault();
      const lines = text
        .split(/\\r\\n|\\n|\\r/)
        .map(function(l){ return l.trim(); })
        .filter(function(l){ return l.length > 0; });
      if (lines.length === 0) return;
      if (isSpeakerInput) {
        post({ type: 'addSpeakers', names: lines });
        t.value = '';
        return;
      }
      if (isRoomInput) {
        const kindEl = document.getElementById('add-room-kind');
        const kind = (kindEl && (kindEl.value === 'plenary' || kindEl.value === 'breakout')) ? kindEl.value : 'breakout';
        post({ type: 'addRooms', names: lines, kind: kind });
        t.value = '';
        return;
      }
      // Speaker-picker filter input: a multi-line paste means "replace
      // this session's speakers with these names". Unknown names get
      // auto-added to the pool; same-timeslot conflicts get resolved on
      // the wired side and surfaced via a modal listing each move.
      post({ type: 'replaceSessionSpeakersByNames', sessionId: pickerSessionId, names: lines });
      t.value = '';
      // Close the picker — the operator just finished an explicit action
      // and we don't want the filter list lingering with stale state.
      const picker = root.querySelector('.speaker-picker[data-speaker-picker-for="' + cssEscape(pickerSessionId) + '"]');
      if (picker) picker.hidden = true;
    });

    // Button clicks — single delegated listener
    root.addEventListener('click', function(e){
      const t = e.target;
      if (!t) return;

      if (t.id === 'add-speaker-btn') {
        const inp = document.getElementById('add-speaker-name');
        const name = inp && inp.value ? inp.value.trim() : '';
        if (!name) return;
        post({ type: 'addSpeaker', name: name });
        if (inp) inp.value = '';
        return;
      }
      if (t.id === 'add-room-btn') {
        const inp = document.getElementById('add-room-name');
        const kindEl = document.getElementById('add-room-kind');
        const name = inp && inp.value ? inp.value.trim() : '';
        const kind = kindEl && (kindEl.value === 'plenary' || kindEl.value === 'breakout') ? kindEl.value : 'breakout';
        if (!name) return;
        post({ type: 'addRoom', name: name, kind: kind });
        if (inp) inp.value = '';
        return;
      }
      if (t.id === 'regenerate-btn') {
        const cfg = {};
        const inputs = root.querySelectorAll('input[data-config-key]');
        for (let i = 0; i < inputs.length; i++) {
          const el = inputs[i];
          const k = el.dataset.configKey;
          const v = Number(el.value);
          if (Number.isFinite(v)) cfg[k] = v;
        }
        post({ type: 'regenerate', config: cfg });
        return;
      }
      if (t.id === 'open-text-btn') {
        post({ type: 'openAsText' });
        return;
      }
      if (t.id === 'generate-folders-btn') {
        post({ type: 'generateFolders' });
        return;
      }
      if (t.id === 'bind-title-slides-btn') {
        post({ type: 'bindTitleSlides' });
        return;
      }
      if (t.id === 'generate-title-slides-btn') {
        post({ type: 'generateTitleSlides' });
        return;
      }
      if (t.id === 'apply-defaults-btn') {
        post({ type: 'applyDefaultTimeslotsToAllDays' });
        return;
      }
      if (t.id === 'clear-all-btn') {
        // Modal-confirm happens on the wired side. No client-side guard
        // here — the wired layer is the source of truth.
        post({ type: 'clearAll' });
        return;
      }

      // Timeslot add / remove / reorder. All four work off the day's
      // current row order read from the DOM via timeslotsForDay().
      if (t.dataset && t.dataset.addTs) {
        post({ type: 'addTimeslot', day: t.dataset.addTs });
        return;
      }
      if (t.dataset && t.dataset.removeTs) {
        const parts = t.dataset.removeTs.split('::');
        if (parts.length !== 2) return;
        post({ type: 'removeTimeslot', day: parts[0], label: parts[1] });
        return;
      }
      if (t.dataset && (t.dataset.reorderTsUp || t.dataset.reorderTsDown)) {
        const raw = t.dataset.reorderTsUp || t.dataset.reorderTsDown;
        const parts = raw.split('::');
        if (parts.length !== 2) return;
        const day = parts[0];
        const label = parts[1];
        const order = timeslotsForDay(day);
        const idx = order.indexOf(label);
        if (idx === -1) return;
        const targetIdx = t.dataset.reorderTsUp ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= order.length) return;
        const newOrder = order.slice();
        newOrder[idx] = order[targetIdx];
        newOrder[targetIdx] = label;
        post({ type: 'reorderTimeslots', day: day, newOrder: newOrder });
        return;
      }

      // Per-room session swap. The neighbour label comes from the day's
      // current row order — the cell carries data-ts so we can find its
      // position in the day's list, then pick prev/next.
      if (t.dataset && (t.dataset.swapUp || t.dataset.swapDown)) {
        const cell = t.closest ? t.closest('td.cell-filled') : null;
        if (!cell) return;
        const day = cell.getAttribute('data-day');
        const roomId = cell.getAttribute('data-room');
        const labelA = cell.getAttribute('data-ts');
        if (!day || !roomId || !labelA) return;
        const order = timeslotsForDay(day);
        const idx = order.indexOf(labelA);
        if (idx === -1) return;
        const targetIdx = t.dataset.swapUp ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= order.length) return;
        post({
          type: 'swapSessionsInRoom',
          day: day,
          roomId: roomId,
          labelA: labelA,
          labelB: order[targetIdx],
        });
        return;
      }

      if (t.dataset && t.dataset.removeSpeaker) {
        post({ type: 'removeSpeaker', speakerId: t.dataset.removeSpeaker });
        return;
      }
      if (t.dataset && t.dataset.removeRoom) {
        post({ type: 'removeRoom', roomId: t.dataset.removeRoom });
        return;
      }
      if (t.dataset && t.dataset.removeSession) {
        post({ type: 'removeSession', sessionId: t.dataset.removeSession });
        return;
      }
      if (t.dataset && t.dataset.addSession) {
        const parts = t.dataset.addSession.split('::');
        if (parts.length !== 3) return;
        const kind = parts[2] === 'plenary' ? 'plenary-open' : 'breakout';
        post({ type: 'addSession', day: parts[0], timeslot: parts[1], roomId: parts[2], kind: kind, speakerIds: [] });
        return;
      }

      // Chip × — remove the speaker. Compute the new order from the DOM
      // (minus the removed chip) and post setSessionSpeakers. The re-render
      // confirms.
      if (t.dataset && t.dataset.chipRemove) {
        const chip = t.closest ? t.closest('.chip') : null;
        const row = chip ? chip.closest('.chip-row') : null;
        if (!row) return;
        const sessionId = row.getAttribute('data-session-id');
        if (!sessionId) return;
        const removeId = t.dataset.chipRemove;
        const next = chipRowOrder(sessionId).filter(function(id){ return id !== removeId; });
        post({ type: 'setSessionSpeakers', sessionId: sessionId, speakerIds: next });
        return;
      }

      // Chip + — open the speaker picker for this session. Picker state
      // lives entirely in the DOM (hidden attribute + filter input). Re-
      // renders after a mutation reset it.
      if (t.dataset && t.dataset.chipAddFor) {
        const sessionId = t.dataset.chipAddFor;
        const picker = root.querySelector('.speaker-picker[data-speaker-picker-for="' + cssEscape(sessionId) + '"]');
        if (!picker) return;
        const willOpen = picker.hidden;
        // Close any other open pickers first — single-active rule.
        const openPickers = root.querySelectorAll('.speaker-picker:not([hidden])');
        for (let i = 0; i < openPickers.length; i++) openPickers[i].hidden = true;
        picker.hidden = !willOpen;
        if (willOpen) {
          const filter = picker.querySelector('.picker-filter');
          if (filter) {
            filter.value = '';
            // Show all rows after reopening — filter starts empty.
            const rows = picker.querySelectorAll('.picker-row');
            for (let i = 0; i < rows.length; i++) rows[i].hidden = false;
            try { filter.focus(); } catch (_) {}
          }
        }
        return;
      }

      // Picker row click — append speaker to session, close picker, post.
      const pickerRow = t.closest ? t.closest('.picker-row[data-picker-speaker-id]') : null;
      if (pickerRow) {
        const speakerId = pickerRow.getAttribute('data-picker-speaker-id');
        const picker = pickerRow.closest('.speaker-picker');
        const sessionId = picker ? picker.getAttribute('data-speaker-picker-for') : null;
        if (!sessionId || !speakerId) return;
        const next = chipRowOrder(sessionId).concat([speakerId]);
        if (picker) picker.hidden = true;
        post({ type: 'setSessionSpeakers', sessionId: sessionId, speakerIds: next });
        return;
      }
    });

    // Drag-to-reorder. Native HTML5 DnD. The drag source is a chip; the
    // drop target is another chip in the same row. We swap-by-insertion:
    // dropping onto the right half of a chip places the dragged one after
    // it; left half places it before. On drop, read the new order from the
    // DOM and post.
    let dragSourceId = null;
    let dragSourceRow = null;

    root.addEventListener('dragstart', function(e){
      const chip = e.target && e.target.closest ? e.target.closest('.chip[data-speaker-id]') : null;
      if (!chip) return;
      dragSourceId = chip.getAttribute('data-speaker-id');
      dragSourceRow = chip.closest('.chip-row');
      chip.classList.add('chip-dragging');
      // Firefox / Chromium both require setData to make the drag start.
      try { e.dataTransfer.setData('text/plain', dragSourceId || ''); } catch (_) {}
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    root.addEventListener('dragend', function(e){
      const chip = e.target && e.target.closest ? e.target.closest('.chip[data-speaker-id]') : null;
      if (chip) chip.classList.remove('chip-dragging');
      // Clear any drop-indicator artifacts in case the user cancelled.
      const indicators = root.querySelectorAll('.chip-drop-before, .chip-drop-after');
      for (let i = 0; i < indicators.length; i++) {
        indicators[i].classList.remove('chip-drop-before');
        indicators[i].classList.remove('chip-drop-after');
      }
      dragSourceId = null;
      dragSourceRow = null;
    });

    root.addEventListener('dragover', function(e){
      if (!dragSourceId || !dragSourceRow) return;
      const targetChip = e.target && e.target.closest ? e.target.closest('.chip[data-speaker-id]') : null;
      if (!targetChip) return;
      const targetRow = targetChip.closest('.chip-row');
      if (targetRow !== dragSourceRow) return; // only reorder within the same session
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      // Clear sibling indicators, mark this one.
      const siblings = targetRow.querySelectorAll('.chip');
      for (let i = 0; i < siblings.length; i++) {
        siblings[i].classList.remove('chip-drop-before');
        siblings[i].classList.remove('chip-drop-after');
      }
      const rect = targetChip.getBoundingClientRect();
      const midpoint = rect.left + rect.width / 2;
      if (e.clientX < midpoint) {
        targetChip.classList.add('chip-drop-before');
      } else {
        targetChip.classList.add('chip-drop-after');
      }
    });

    root.addEventListener('drop', function(e){
      if (!dragSourceId || !dragSourceRow) return;
      const targetChip = e.target && e.target.closest ? e.target.closest('.chip[data-speaker-id]') : null;
      if (!targetChip) return;
      const targetRow = targetChip.closest('.chip-row');
      if (targetRow !== dragSourceRow) return;
      e.preventDefault();
      const targetId = targetChip.getAttribute('data-speaker-id');
      if (!targetId || targetId === dragSourceId) return;
      const sessionId = targetRow.getAttribute('data-session-id');
      if (!sessionId) return;

      // Compute the new order: take the current row order, drop the source
      // id, re-insert before or after the target depending on which half
      // of the target the drop landed on.
      const rect = targetChip.getBoundingClientRect();
      const dropAfter = e.clientX >= rect.left + rect.width / 2;
      const current = chipRowOrder(sessionId);
      const withoutSource = current.filter(function(id){ return id !== dragSourceId; });
      const idx = withoutSource.indexOf(targetId);
      if (idx === -1) return;
      const insertAt = dropAfter ? idx + 1 : idx;
      const next = withoutSource.slice(0, insertAt).concat([dragSourceId]).concat(withoutSource.slice(insertAt));
      post({ type: 'setSessionSpeakers', sessionId: sessionId, speakerIds: next });
    });
  })();`;
}

// ───── CSS ─────────────────────────────────────────────────────────────

function pageCss(): string {
  return `
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 20px;
      font-size: var(--vscode-font-size, 13px);
    }
    main { max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
    h1 { font-size: 1.6em; margin: 0 0 8px 0; }
    h2 { font-size: 1.15em; margin: 0 0 8px 0; display: flex; align-items: baseline; gap: 8px; }
    h2 .evt-count {
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
    }
    h3 { font-size: 1em; margin: 12px 0 4px 0; }
    .evt-section {
      padding: 14px 18px;
      background: var(--vscode-editorWidget-background, transparent);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
    }
    .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0 12px; }
    .muted { color: var(--vscode-descriptionForeground); }
    .banner { padding: 10px 14px; border-radius: 4px; border: 1px solid; }
    .banner-warn {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent);
      border-color: var(--vscode-editorWarning-foreground, #cca700);
    }
    .banner ul { margin: 6px 0 0 18px; padding: 0; }
    .evt-head { display: flex; flex-direction: column; gap: 8px; }
    .evt-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
    .evt-field { display: flex; flex-direction: column; gap: 2px; min-width: 220px; flex: 1 1 220px; }
    .evt-field > span { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
    /* Input + inline action button — used for the "Default timeslot labels"
       row so "Apply to all" sits flush to the right of the input. Flex with
       the input growing (flex:1) and the button keeping its intrinsic width. */
    .evt-field-with-action { display: flex; gap: 8px; align-items: stretch; }
    .evt-field-with-action > input { flex: 1 1 auto; min-width: 0; }
    .evt-field-with-action > button { flex: 0 0 auto; }
    input[type="text"], input[type="number"], select {
      font-family: inherit;
      font-size: inherit;
      padding: 4px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
      border-radius: 2px;
    }
    .evt-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .evt-list-row {
      display: grid;
      grid-template-columns: 80px 1fr auto auto;
      gap: 10px;
      align-items: center;
      padding: 4px 6px;
      border-radius: 2px;
    }
    .evt-list-row:hover { background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent); }
    .evt-list-id { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); font-size: 0.85em; }
    .evt-list-name { width: 100%; }
    .evt-list-plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .evt-add-row {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
      padding-top: 10px;
      border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.25));
    }
    .evt-add-row input[type="text"] { flex: 1 1 auto; }
    .evt-room-kind {
      font-size: 0.75em;
      padding: 2px 6px;
      border-radius: 9999px;
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    }
    .kind-plenary { background: color-mix(in srgb, var(--vscode-charts-blue, #4caf50) 20%, transparent); }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 6px 8px; }
    .btn {
      font-family: inherit;
      font-size: inherit;
      padding: 4px 12px;
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-button-background, #0e639c);
      border: 1px solid transparent;
      border-radius: 2px;
      cursor: pointer;
    }
    .btn:hover:not(:disabled) { filter: brightness(1.1); }
    .btn:disabled { opacity: 0.55; cursor: not-allowed; }
    .btn-sm { padding: 2px 8px; font-size: 0.85em; }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    .btn-danger {
      background: var(--vscode-errorForeground, #f14c4c);
      color: #fff;
    }
    .btn-warn {
      background: var(--vscode-editorWarning-foreground, #cca700);
      color: #1e1e1e;
    }
    /* Sessions grid */
    .day-block { margin-top: 14px; }
    .sessions-grid { border-collapse: collapse; width: 100%; }
    .sessions-grid th, .sessions-grid td {
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      vertical-align: top;
      padding: 4px;
    }
    .sessions-grid thead th {
      background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
      font-weight: 600;
      font-size: 0.9em;
    }
    .sessions-grid th.ts {
      width: 60px;
      text-align: center;
      background: color-mix(in srgb, var(--vscode-foreground) 8%, transparent);
    }
    .room-name { display: block; }
    .room-id { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground); font-size: 0.8em; }
    .cell { min-width: 140px; padding: 0 !important; }
    .cell-empty { text-align: center; padding: 0; }
    .cell-add {
      width: 100%;
      min-height: 36px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: none;
      cursor: pointer;
      font-size: 1.4em;
    }
    .cell-add:hover {
      background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 12%, transparent);
      color: var(--vscode-foreground);
    }
    .cell-filled details { padding: 6px 8px; }
    .cell-filled summary { cursor: pointer; list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .cell-filled summary::-webkit-details-marker { display: none; }
    .kind-pill {
      display: inline-block;
      font-size: 0.7em;
      padding: 1px 6px;
      border-radius: 9999px;
      background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
      text-transform: lowercase;
    }
    .kind-plenary-open, .kind-plenary-close {
      background: color-mix(in srgb, var(--vscode-charts-blue, #4caf50) 25%, transparent);
    }
    .kind-breakout-relocated {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent);
    }
    .badge { display: inline-block; font-size: 0.7em; padding: 1px 6px; border-radius: 9999px; }
    .badge-relocated {
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent);
    }
    .speaker-pills {
      list-style: none;
      margin: 0;
      padding: 0;
      font-size: 0.85em;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .session-edit-body {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.25));
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .evt-field-label {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      display: block;
      margin-bottom: 4px;
    }
    /* Speaker chip row — drag-to-reorder lives here */
    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      padding: 4px;
      min-height: 32px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      background: color-mix(in srgb, var(--vscode-foreground) 3%, transparent);
    }
    .chip-row-empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      font-size: 0.9em;
      padding: 0 4px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 4px 2px 8px;
      border-radius: 9999px;
      background: var(--vscode-badge-background, color-mix(in srgb, var(--vscode-button-background, #0e639c) 25%, transparent));
      color: var(--vscode-badge-foreground, var(--vscode-foreground));
      font-size: 0.9em;
      cursor: grab;
      user-select: none;
      transition: transform 100ms ease-out, opacity 100ms ease-out;
    }
    .chip:active { cursor: grabbing; }
    .chip-dragging { opacity: 0.4; }
    /* Drop-target indicators: a coloured edge on the side the dragged
       chip would land. Pure visual feedback; doesn't change layout. */
    .chip-drop-before { box-shadow: -3px 0 0 0 var(--vscode-focusBorder, #0e639c); }
    .chip-drop-after { box-shadow: 3px 0 0 0 var(--vscode-focusBorder, #0e639c); }
    .chip-name { line-height: 1.2; }
    .chip-remove {
      font-family: inherit;
      font-size: 1em;
      line-height: 1;
      padding: 0;
      width: 18px;
      height: 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 9999px;
      background: transparent;
      color: inherit;
      opacity: 0.75;
      cursor: pointer;
    }
    .chip-remove:hover {
      background: color-mix(in srgb, var(--vscode-foreground) 20%, transparent);
      opacity: 1;
    }
    .chip-add {
      font-family: inherit;
      font-size: 1.1em;
      line-height: 1;
      padding: 0;
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,0.4));
      border-radius: 9999px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
    }
    .chip-add:hover {
      background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 12%, transparent);
      color: var(--vscode-foreground);
      border-style: solid;
    }
    /* Speaker picker — inline popover-style below the chip row */
    .speaker-picker {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 6px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.25));
      border-radius: 4px;
      background: var(--vscode-editorWidget-background, transparent);
    }
    .speaker-picker[hidden] { display: none; }
    .picker-filter { width: 100%; }
    .picker-list {
      list-style: none;
      margin: 0;
      padding: 0;
      max-height: 180px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .picker-row {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 6px;
      border-radius: 2px;
      cursor: pointer;
    }
    .picker-row[hidden] { display: none; }
    .picker-row:hover {
      background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 18%, transparent);
    }
    .picker-name { color: var(--vscode-foreground); }
    .picker-id { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); font-size: 0.85em; }
    .picker-empty {
      padding: 6px 8px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    /* Tools (regenerate) */
    .evt-tools details summary {
      cursor: pointer;
      list-style: none;
    }
    .evt-tools details summary::-webkit-details-marker { display: none; }
    .evt-tools-regen-label {
      /* Replaces the old <h2> inside the Regenerate <summary>. Span keeps
         the heading semantics confined to the section title above; the
         summary label is just a clickable disclosure handle. */
      font-size: 1em;
      font-weight: 600;
    }
    .evt-config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin: 12px 0;
    }

    /* ─── M4: session title line in cell summary ────────────────────────
       The title row sits above the speaker pills. Two visual states:
       authored title (regular) vs. kind-fallback (muted italic). The
       different look lets the user see at a glance whether a session
       has been titled or is showing its default. */
    .session-title {
      font-size: 0.85em;
      display: block;
      line-height: 1.3;
    }
    .session-title-default {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    /* ─── M4: hover-revealed swap arrows on filled cells ──────────────
       The arrows live in the right edge of each filled cell and let the
       user swap a session up or down with its row-neighbour in the same
       room. They're absolutely-positioned inside the cell so they don't
       push the cell's <details> around when revealed.

       For absolute positioning to anchor to a parent the parent needs
       position:relative — otherwise an absolutely-positioned child walks
       up the ancestor chain to the nearest positioned element (often
       the <body>). Setting td.cell-filled {position:relative} keeps the
       arrows pinned to their owning cell.

       Default state: opacity 0 (invisible but still occupying space).
       On cell hover: fade to opacity 0.85 via a 100ms transition so the
       reveal feels deliberate rather than a flash. z-index:2 keeps the
       arrows above the <details>'s focus outline. */
    td.cell-filled { position: relative; }
    .cell-swap-up, .cell-swap-down {
      position: absolute;
      right: 4px;
      width: 18px;
      height: 18px;
      padding: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.7em;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 100ms ease-out;
      z-index: 2;
    }
    .cell-swap-up { top: 4px; }
    .cell-swap-down { bottom: 4px; }
    td.cell-filled:hover .cell-swap-up,
    td.cell-filled:hover .cell-swap-down { opacity: 0.85; }
    .cell-swap-up:hover, .cell-swap-down:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }
    /* Edge guards. The first row has no row above (so ▲ has no target),
       the last row has no row below. data-row-first / data-row-last are
       stamped on the <tr> by the renderer; CSS hides the relevant arrow
       via visibility:hidden — which keeps the absolute layout intact
       (using display:none would also work for absolute children, but
       visibility is more predictable). */
    tr.ts-row[data-row-first] .cell-swap-up,
    tr.ts-row[data-row-first] .ts-up { visibility: hidden; }
    tr.ts-row[data-row-last] .cell-swap-down,
    tr.ts-row[data-row-last] .ts-down { visibility: hidden; }

    /* ─── M4: row-header cell with rename + reorder + delete ───────────
       The header cell is narrow (80px) and stacks four controls in a
       flex column: ▲ reorder-up, the label input, ▼ reorder-down, ✕
       delete. The input looks borderless at rest — the user sees just
       the label text — and only acquires a normal input look on hover
       or focus. This keeps the grid uncluttered while still being
       directly editable.

       box-sizing:border-box ensures the input's border and padding count
       toward its declared width:100%, so it never overflows the column
       when the focused border lands. */
    th.ts { width: 80px; }
    .ts-cell {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 2px;
      padding: 2px 0;
    }
    .ts-label {
      width: 100%;
      box-sizing: border-box;
      text-align: center;
      border: 1px solid transparent;
      background: transparent;
      color: inherit;
      font-family: inherit;
      font-size: inherit;
      padding: 2px 4px;
      border-radius: 2px;
    }
    .ts-label:hover {
      border-color: var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.4)));
    }
    .ts-label:focus {
      border-color: var(--vscode-focusBorder, var(--vscode-input-border, #0e639c));
      background: var(--vscode-input-background);
      outline: none;
    }
    /* Invalid label feedback. The client script toggles
       .ts-label-invalid when the user types a forbidden character or
       the wired layer rejects a rename. The !important flags override
       the hover/focus border colours so the red is unmistakable. */
    .ts-label-invalid {
      border-color: var(--vscode-errorForeground, #f14c4c) !important;
      background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 8%, transparent) !important;
    }
    .ts-up, .ts-down, .ts-remove {
      width: 100%;
      padding: 0;
      height: 16px;
      line-height: 16px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 2px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-size: 0.7em;
      opacity: 0;
      transition: opacity 100ms ease-out;
    }
    tr.ts-row:hover .ts-up,
    tr.ts-row:hover .ts-down,
    tr.ts-row:hover .ts-remove { opacity: 0.85; }
    .ts-up:hover, .ts-down:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    }
    .ts-remove:hover {
      opacity: 1;
      background: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 12%, transparent);
      color: var(--vscode-errorForeground, #f14c4c);
      border-color: var(--vscode-errorForeground, #f14c4c);
    }

    /* ─── M4: "+ Add timeslot" trailing row ─────────────────────────
       Spans the entire grid width via colspan (set in the renderer);
       the cell carries a dashed-border placeholder look so it reads as
       "this is an empty slot waiting for input" rather than a real
       data row. The !important flag on padding overrides the generic
       .sessions-grid td {padding:4px} rule above — cascading
       specificity is per-property, so without it the default padding
       wins (same selector specificity, later declaration only wins if
       same rule). */
    .ts-add-row td {
      padding: 4px 0 !important;
      border-style: dashed !important;
      background: transparent;
    }
    .btn-add-ts {
      width: 100%;
      padding: 4px 8px;
      background: transparent;
      border: 1px dashed transparent;
      border-radius: 2px;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      font-family: inherit;
      font-size: inherit;
    }
    .btn-add-ts:hover {
      background: color-mix(in srgb, var(--vscode-button-background, #0e639c) 12%, transparent);
      color: var(--vscode-foreground);
      border-color: var(--vscode-panel-border, rgba(128,128,128,0.4));
    }

    /* ─── M4: Tools-section header with inline Clear button ────────
       Flexbox lays the heading and Clear button on one line.
       align-items:baseline aligns the text baselines (so the button text
       sits on the same line as the heading text, regardless of their
       different font sizes). justify-content:space-between pushes the
       two children to opposite ends of the row. */
    .evt-tools-header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
    }
    .evt-tools-header h2 { margin: 0; }
  `;
}

// ───── escaping ────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}
