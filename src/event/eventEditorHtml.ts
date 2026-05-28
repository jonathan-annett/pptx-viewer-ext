// Pure HTML renderer for the `.eventSchedule` custom editor.
//
// Mirrors the structure used by the sync feature's pure renderers
// (configEditorHtml, adminEditorHtml, manifestEditorHtml): take a fully-
// resolved view model, return a string, never import vscode. The webview
// posts typed action messages back to the wired layer in eventEditor.ts.
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
// The webview state lives entirely in the DOM; the extension re-renders
// the full body on every docChanged message. No client-side framework.

import type { EventEditorViewModel } from './eventEditor';
import type {
  EventConfig,
  EventRoom,
  EventSchedule,
  EventSession,
  EventSpeaker,
  EventVacancy,
  SessionKind,
} from './schedule';
import { allTimeslotLetters } from './schedule';

export function renderEventEditorHtml(
  vm: EventEditorViewModel,
  nonce: string,
): string {
  const css = pageCss();
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
  const timeslots = s.timeslots.length > 0 ? s.timeslots : allTimeslotLetters(s.config);
  // index sessions by (day, timeslot, roomId) → session
  const sessionAt = new Map<string, EventSession>();
  for (const sess of s.sessions) {
    sessionAt.set(`${sess.day}::${sess.timeslot}::${sess.roomId}`, sess);
  }
  const speakerById = new Map(s.speakers.map((sp) => [sp.id, sp]));
  const dayBlocks = s.config.days.map((day) => renderDayBlock(s, day, timeslots, sessionAt, speakerById)).join('\n');
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
  const rows = timeslots
    .map((timeslot) => {
      const cells = s.rooms
        .map((room) => {
          const sess = sessionAt.get(`${day}::${timeslot}::${room.id}`);
          return renderCell(sess, day, timeslot, room, speakerById);
        })
        .join('');
      return `<tr><th class="ts">${escapeHtml(timeslot)}</th>${cells}</tr>`;
    })
    .join('');
  return `<div class="day-block">
    <h3>${escapeHtml(day)}</h3>
    <table class="sessions-grid">
      <thead><tr><th class="ts">Time</th>${headerCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function renderCell(
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
  const relocBadge = sess.kind === 'breakout-relocated' && sess.relocatedFromRoomId
    ? `<span class="badge badge-relocated" title="Relocated from ${escapeAttr(sess.relocatedFromRoomId)}">↳ from ${escapeHtml(sess.relocatedFromRoomId)}</span>`
    : '';
  return `<td class="cell cell-filled" data-day="${escapeAttr(day)}" data-ts="${escapeAttr(timeslot)}" data-room="${escapeAttr(room.id)}" data-session-id="${escapeAttr(sess.id)}">
    <details class="session-edit">
      <summary>
        <span class="kind-pill kind-${escapeAttr(sess.kind)}">${escapeHtml(sess.kind)}</span>
        ${relocBadge}
        <ul class="speaker-pills">${speakerList}</ul>
      </summary>
      <div class="session-edit-body">
        ${renderSessionEditForm(sess)}
      </div>
    </details>
  </td>`;
}

function renderSessionEditForm(sess: EventSession): string {
  const kindOptions: SessionKind[] = ['breakout', 'plenary-open', 'plenary-close', 'breakout-relocated'];
  const kindSelect = kindOptions
    .map(
      (k) => `<option value="${k}"${k === sess.kind ? ' selected' : ''}>${k}</option>`,
    )
    .join('');
  // Speaker assignment: comma-separated speaker ids (or names). Editing
  // inline keeps the v1 surface small; a richer multi-select can land later.
  const ids = sess.speakers.map((sl) => sl.speakerId).join(', ');
  return `<div class="evt-row">
    <label class="evt-field">
      <span>Session kind</span>
      <select data-session-kind="${escapeAttr(sess.id)}">${kindSelect}</select>
    </label>
  </div>
  <div class="evt-row">
    <label class="evt-field">
      <span>Speaker IDs (comma-separated, in order)</span>
      <input type="text" data-session-speakers="${escapeAttr(sess.id)}" value="${escapeAttr(ids)}" autocomplete="off">
    </label>
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
  // Hide the Regenerate Tools section entirely on authored files so a
  // misclick can never wipe the user's data. The wired layer also enforces
  // this on its side (sha-against-placeholder-registry check), so a stale
  // tab can't bypass.
  if (!vm.isPlaceholder) {
    return `<section class="evt-section evt-tools">
      <h2>Tools</h2>
      <p class="hint">Regenerate is only available on placeholder schedules. This file has authored data.</p>
      <p><button type="button" class="btn btn-secondary" id="open-text-btn">Reopen as text</button></p>
    </section>`;
  }
  const c = vm.schedule.config;
  return `<section class="evt-section evt-tools">
    <details>
      <summary><h2>Tools — Regenerate from config</h2></summary>
      <p class="hint">
        Fill these and press Regenerate. The file is rebuilt from scratch — speakers, rooms, and sessions are replaced with a freshly generated set. Available only because this file is currently empty or matches a placeholder hash.
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
        <button type="button" class="btn btn-warn" id="regenerate-btn" title="Re-run the generator and replace this file's contents">Regenerate</button>
        <button type="button" class="btn btn-secondary" id="open-text-btn">Reopen as text</button>
      </p>
    </details>
  </section>`;
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

    // Replace the body on every docChanged so the form always mirrors disk.
    window.addEventListener('message', function(e){
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'docChanged' && m.payload && typeof m.payload === 'object') {
        // Server re-render: the extension re-issued the full HTML body via
        // a separate path; nothing to do here. The wired layer alternatively
        // sends the parsed VM as JSON for in-place updates. v1 keeps it
        // simple: any docChanged forces a postMessage round trip is unneeded
        // because the extension also re-renders panel.webview.html when the
        // doc changes for non-self writes — but the suppression flag covers
        // own writes. So docChanged is informational; no-op for now.
      }
    });

    function speakerIdsFromString(raw){
      if (typeof raw !== 'string') return [];
      return raw.split(',').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
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
      }
    });

    // Speaker / room rename via blur
    root.addEventListener('blur', function(e){
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.renameSpeaker) {
        post({ type: 'renameSpeaker', speakerId: t.dataset.renameSpeaker, name: t.value });
      } else if (t.dataset.renameRoom) {
        post({ type: 'renameRoom', roomId: t.dataset.renameRoom, name: t.value });
      } else if (t.dataset.sessionSpeakers) {
        post({ type: 'setSessionSpeakers', sessionId: t.dataset.sessionSpeakers, speakerIds: speakerIdsFromString(t.value) });
      }
    }, true);

    // Session-kind dropdown (change fires on selection)
    root.addEventListener('change', function(e){
      const t = e.target;
      if (!t || !t.dataset) return;
      if (t.dataset.sessionKind) {
        post({ type: 'setSessionKind', sessionId: t.dataset.sessionKind, kind: t.value });
      }
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
    /* Tools (regenerate) */
    .evt-tools details summary {
      cursor: pointer;
      list-style: none;
    }
    .evt-tools details summary::-webkit-details-marker { display: none; }
    .evt-tools details summary h2 { display: inline-flex; }
    .evt-config-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
      margin: 12px 0;
    }
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
