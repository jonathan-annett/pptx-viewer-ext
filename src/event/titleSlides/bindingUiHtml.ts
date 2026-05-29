// Pure HTML renderer for the title-slide template binding panel.
//
// Simpler-than-the-original-spec v1 UX: render every text frame as a row
// with a role dropdown, not a clickable visual slide preview. The user
// already knows which frame is which from its sample text — a list is
// fast to scan and quick to implement, and we can swap for a visual
// preview in v1.x without changing the binding shape.
//
// Multi-line speaker bindings (`line` field) are NOT exposed in the UI
// in v1 — they're hand-editable via the JSON schema if needed. The
// generator handles them either way.
//
// Pure module — no vscode imports. Tested via test/title-slides-bindingUiHtml.test.ts.

import type { TemplateInspectResult } from './templateInspect';
import type { TitleSlidesBinding } from './binding';

// ───── View model ────────────────────────────────────────────────────────

export interface BindingPanelViewModel {
  /** Display path for the template — usually the URI path or basename. */
  templatePath: string;
  /** Result of `inspectTemplate(templateBytes)`. */
  inspection: TemplateInspectResult;
  /** Existing binding to pre-populate the dropdowns. Absent → all unbound. */
  existing?: TitleSlidesBinding;
}

// ───── Top-level renderer ────────────────────────────────────────────────

export function renderBindingPanelHtml(
  vm: BindingPanelViewModel,
  nonce: string,
): string {
  const initJson = escapeForScript(JSON.stringify({
    templatePath: vm.templatePath,
    inspection: vm.inspection,
    existing: vm.existing ?? null,
  }));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<title>Bind title-slide template</title>
<style>${pageCss()}</style>
</head>
<body>
  <main id="root">${renderBody(vm)}</main>
  <script nonce="${nonce}" id="binding-init" type="application/json">${initJson}</script>
  <script nonce="${nonce}">${clientScript()}</script>
</body>
</html>`;
}

/** Exported for tests + render-without-script paths. */
export function renderBody(vm: BindingPanelViewModel): string {
  return [
    renderHeader(vm),
    renderSlideRoles(vm),
    renderFrameList(vm),
    renderOptions(vm),
    renderActions(),
    renderTips(),
  ].join('\n');
}

// ───── Sections ──────────────────────────────────────────────────────────

function renderHeader(vm: BindingPanelViewModel): string {
  return `<header class="bind-head">
    <h1>Bind title-slide template</h1>
    <p class="bind-template-row">
      <span>Template:</span>
      <code id="bind-template-path">${escapeHtml(vm.templatePath)}</code>
      <button type="button" class="btn btn-secondary" id="bind-change-template-btn">Change template…</button>
    </p>
  </header>`;
}

function renderSlideRoles(vm: BindingPanelViewModel): string {
  const visibleCount =
    (vm.inspection.walkIn ? 1 : 0) + 1 + vm.inspection.supplementary.length;
  const hiddenCount = vm.inspection.hidden.length;
  const rows: string[] = [];
  if (vm.inspection.walkIn) {
    rows.push(`<li>Walk-in (copied verbatim — no fields to bind)</li>`);
  }
  rows.push(`<li><strong>Template</strong> — assign roles to its text frames below</li>`);
  if (vm.inspection.supplementary.length > 0) {
    rows.push(
      `<li>${vm.inspection.supplementary.length} supplementary ` +
      `slide${vm.inspection.supplementary.length === 1 ? '' : 's'} ` +
      `(appended verbatim to the output deck)</li>`,
    );
  }
  return `<section class="bind-section">
    <h2>Detected: ${visibleCount} visible slide${visibleCount === 1 ? '' : 's'}${
      hiddenCount > 0 ? ` (+ ${hiddenCount} hidden, ignored)` : ''
    }</h2>
    <ul class="bind-role-list">${rows.join('')}</ul>
  </section>`;
}

function renderFrameList(vm: BindingPanelViewModel): string {
  const bindingByFrame = new Map<number, string>();   // frame → role
  if (vm.existing) {
    for (const f of vm.existing.fields) {
      // Line-bound speakers: keep as 'speaker' role for the dropdown,
      // but the actual binding is preserved verbatim on save (the
      // client carries the original `line` value through unmodified
      // for frames whose lines were authored by hand).
      bindingByFrame.set(f.frame, f.role);
    }
  }
  if (vm.inspection.textFrames.length === 0) {
    return `<section class="bind-section">
      <h2>Text frames</h2>
      <p class="bind-empty">No text-bearing shapes found on the template slide. Add some text frames to your template before binding.</p>
    </section>`;
  }
  const rows = vm.inspection.textFrames.map((f) => {
    const existingRole = bindingByFrame.get(f.index) ?? 'unbound';
    const preview = f.sampleText.length > 80
      ? f.sampleText.slice(0, 80) + '…'
      : f.sampleText;
    const lineNote = f.lines.length > 1
      ? ` <span class="bind-line-note">(${f.lines.length} lines — first line shown; binding the frame populates the first line only in v1)</span>`
      : '';
    return `<tr class="bind-frame-row" data-frame="${f.index}">
      <td class="bind-frame-num">${f.index}</td>
      <td class="bind-frame-text">${escapeHtml(preview || '(empty)')}${lineNote}</td>
      <td class="bind-frame-role">
        <select data-frame-role="${f.index}" class="bind-role-select">
          ${roleOptions(existingRole)}
        </select>
      </td>
    </tr>`;
  }).join('');
  return `<section class="bind-section">
    <h2>Text frames on the template slide</h2>
    <p class="hint">Pick a role for each frame. Frames you don't bind stay as their sample text in the generated decks.</p>
    <table class="bind-frame-table">
      <thead>
        <tr><th>#</th><th>Sample text</th><th>Role</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="hint" id="bind-capacity-summary"></p>
  </section>`;
}

function roleOptions(selected: string): string {
  const roles = [
    { value: 'unbound', label: 'Unbound' },
    { value: 'sessionTitle', label: 'Session title' },
    { value: 'roomName', label: 'Room name' },
    { value: 'timeslot', label: 'Timeslot' },
    { value: 'day', label: 'Day' },
    { value: 'speaker', label: 'Speaker' },
  ];
  return roles.map(r =>
    `<option value="${r.value}"${r.value === selected ? ' selected' : ''}>${r.label}</option>`,
  ).join('');
}

function renderOptions(vm: BindingPanelViewModel): string {
  const distChecked = vm.existing?.distributeEvenly ? ' checked' : '';
  return `<section class="bind-section">
    <h2>Options</h2>
    <label class="bind-option">
      <input type="checkbox" id="bind-distribute-evenly"${distChecked}>
      <span>Distribute speakers evenly across overflow slides</span>
      <span class="hint">(5 speakers at capacity 4 → 3+2 instead of 4+1)</span>
    </label>
  </section>`;
}

function renderActions(): string {
  return `<section class="bind-section bind-actions">
    <button type="button" class="btn btn-primary" id="bind-save-btn">Save binding</button>
    <button type="button" class="btn btn-secondary" id="bind-reset-btn">Reset</button>
    <button type="button" class="btn btn-secondary" id="bind-cancel-btn">Cancel</button>
    <span class="bind-status" id="bind-status"></span>
  </section>`;
}

function renderTips(): string {
  return `<section class="bind-section bind-tips">
    <h3>Tips</h3>
    <ul>
      <li><strong>Hidden slides are ignored</strong> — keep old designs around for reference, just hide them in PowerPoint.</li>
      <li><strong>Variants with the same frame layout</strong> can be swapped by hiding/unhiding in PowerPoint; layout changes need re-binding.</li>
      <li><strong>For multiple speakers</strong>, design your template with one text box per speaker — that way each name gets its own hyperlink to the speaker's deck during the event.</li>
      <li><strong>Walk-in &amp; supplementary slides</strong> are copied byte-for-byte. Use them for housekeeping content the operator can show at the start or between sessions.</li>
    </ul>
  </section>`;
}

// ───── CSS ───────────────────────────────────────────────────────────────

function pageCss(): string {
  return `
    body {
      font-family: var(--vscode-font-family, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground, #ccc);
      background: var(--vscode-editor-background, #1e1e1e);
      margin: 0;
      padding: 20px 28px;
      line-height: 1.5;
    }
    main { max-width: 900px; margin: 0 auto; }
    h1 { font-size: 1.6rem; margin: 0 0 8px; }
    h2 { font-size: 1.05rem; margin: 16px 0 8px; }
    h3 { font-size: 0.95rem; margin: 14px 0 6px; }
    .hint {
      color: var(--vscode-descriptionForeground, #888);
      font-size: 0.9em;
      margin: 4px 0;
    }
    .bind-section { margin-bottom: 22px; }
    .bind-template-row {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      margin: 4px 0 0;
    }
    .bind-template-row code {
      background: var(--vscode-textCodeBlock-background, #2b2b2b);
      padding: 2px 6px; border-radius: 3px;
    }
    .bind-role-list { margin: 6px 0; padding-left: 22px; }
    .bind-role-list li { margin: 2px 0; }
    .bind-frame-table {
      width: 100%; border-collapse: collapse; margin-top: 8px;
    }
    .bind-frame-table th, .bind-frame-table td {
      text-align: left; padding: 6px 8px; vertical-align: top;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
    }
    .bind-frame-num {
      width: 36px; color: var(--vscode-descriptionForeground, #888);
      font-variant-numeric: tabular-nums;
    }
    .bind-frame-text { word-break: break-word; }
    .bind-frame-role { width: 180px; }
    .bind-line-note {
      display: block; color: var(--vscode-descriptionForeground, #888);
      font-size: 0.85em; margin-top: 2px;
    }
    .bind-role-select {
      width: 100%;
      background: var(--vscode-input-background, #1e1e1e);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, transparent);
      padding: 4px 6px;
    }
    .bind-option { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .bind-option .hint { margin: 0; }
    .bind-actions {
      display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
      margin-top: 24px;
      padding-top: 16px;
      border-top: 1px solid var(--vscode-panel-border, #444);
    }
    .bind-status {
      margin-left: 8px;
      color: var(--vscode-descriptionForeground, #888);
    }
    .bind-status.bind-status-ok {
      color: var(--vscode-charts-green, #6a9955);
    }
    .bind-status.bind-status-warn {
      color: var(--vscode-editorWarning-foreground, #ddb56b);
    }
    .btn {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      border-radius: 2px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    .btn-secondary {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #fff);
    }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .btn-primary {
      /* primary IS the default — explicit class for grep-ability */
    }
    .bind-tips ul { padding-left: 22px; margin: 6px 0 0; }
    .bind-tips li { margin: 4px 0; color: var(--vscode-descriptionForeground, #aaa); }
    .bind-empty {
      padding: 16px;
      border: 1px dashed var(--vscode-panel-border, #444);
      border-radius: 4px;
      color: var(--vscode-descriptionForeground, #888);
    }
  `;
}

// ───── Client script ─────────────────────────────────────────────────────

function clientScript(): string {
  // Local state pattern: parse the init JSON once, derive a working
  // binding state from the dropdowns, post on Save / Change template /
  // Cancel. No round-trips to the extension during normal interaction.
  //
  // Existing line-bound speaker bindings are preserved verbatim — the
  // UI doesn't expose `line` but we don't want to clobber it if it was
  // hand-authored. We track which frames had a line-bound binding at
  // load time and reapply on save.
  return `(function(){
    var vscode = acquireVsCodeApi();
    var initEl = document.getElementById('binding-init');
    var init = JSON.parse(initEl.textContent || '{}');
    var inspection = init.inspection || { textFrames: [] };
    var existing = init.existing;

    // Map of frame index → line-bound binding to preserve on save.
    var lineBoundByFrame = {};
    if (existing && Array.isArray(existing.fields)) {
      existing.fields.forEach(function(f){
        if (f.role === 'speaker' && typeof f.line === 'number') {
          lineBoundByFrame[String(f.frame)] = f.line;
        }
      });
    }

    function post(msg){
      try { vscode.postMessage(msg); } catch (_) {}
    }

    function readBindingFromForm(){
      var fields = [];
      var selects = document.querySelectorAll('select[data-frame-role]');
      for (var i = 0; i < selects.length; i++) {
        var sel = selects[i];
        var role = sel.value;
        if (role === 'unbound') continue;
        var frameIdx = Number(sel.getAttribute('data-frame-role'));
        var entry = { role: role, frame: frameIdx };
        // Preserve a line-bound speaker binding if the user didn't change the role.
        if (role === 'speaker' && lineBoundByFrame[String(frameIdx)] !== undefined) {
          entry.line = lineBoundByFrame[String(frameIdx)];
        }
        fields.push(entry);
      }
      var distEl = document.getElementById('bind-distribute-evenly');
      var binding = {
        templatePath: init.templatePath,
        fields: fields,
      };
      if (distEl && distEl.checked) binding.distributeEvenly = true;
      return binding;
    }

    function updateCapacitySummary(){
      var selects = document.querySelectorAll('select[data-frame-role]');
      var speakerCount = 0;
      for (var i = 0; i < selects.length; i++) {
        if (selects[i].value === 'speaker') speakerCount++;
      }
      var summary = document.getElementById('bind-capacity-summary');
      if (!summary) return;
      if (speakerCount === 0) {
        summary.textContent = 'No speaker frames bound — speakers won\\'t appear on the generated slides until at least one frame is set to Speaker.';
        summary.classList.add('hint');
      } else {
        summary.textContent = 'Speaker capacity per slide: ' + speakerCount + ' (count of frames set to Speaker). Overflow speakers spill onto additional slides per session.';
      }
    }

    function showStatus(msg, cls){
      var s = document.getElementById('bind-status');
      if (!s) return;
      s.textContent = msg;
      s.classList.remove('bind-status-ok', 'bind-status-warn');
      if (cls) s.classList.add(cls);
    }

    document.addEventListener('change', function(e){
      var t = e.target;
      if (t && t.matches && t.matches('select[data-frame-role]')) {
        updateCapacitySummary();
        showStatus('Unsaved changes', 'bind-status-warn');
      } else if (t && t.id === 'bind-distribute-evenly') {
        showStatus('Unsaved changes', 'bind-status-warn');
      }
    });

    document.addEventListener('click', function(e){
      var t = e.target;
      if (!t || !t.id) return;
      if (t.id === 'bind-save-btn') {
        var binding = readBindingFromForm();
        post({ type: 'save', binding: binding });
        showStatus('Saving…');
      } else if (t.id === 'bind-cancel-btn') {
        post({ type: 'cancel' });
      } else if (t.id === 'bind-reset-btn') {
        var selects = document.querySelectorAll('select[data-frame-role]');
        for (var i = 0; i < selects.length; i++) selects[i].value = 'unbound';
        var distEl = document.getElementById('bind-distribute-evenly');
        if (distEl) distEl.checked = false;
        lineBoundByFrame = {};
        updateCapacitySummary();
        showStatus('Reset to unbound', 'bind-status-warn');
      } else if (t.id === 'bind-change-template-btn') {
        post({ type: 'changeTemplate' });
      }
    });

    window.addEventListener('message', function(evt){
      var msg = evt.data;
      if (!msg) return;
      if (msg.type === 'saved') {
        showStatus('Saved.', 'bind-status-ok');
      } else if (msg.type === 'saveFailed') {
        showStatus('Save failed: ' + (msg.error || 'unknown error'), 'bind-status-warn');
      }
    });

    updateCapacitySummary();
  })();`;
}

// ───── Escaping helpers ──────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeForScript(s: string): string {
  // Embedded JSON inside a <script type="application/json"> tag — the only
  // sequence that breaks parsing is </script (which would close the tag
  // prematurely). Escape the slash.
  return s.replace(/<\/script/gi, '<\\/script');
}
