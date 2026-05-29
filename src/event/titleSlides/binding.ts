// Re-exports + helpers for the title-slide binding shape. Canonical type
// definitions live in `../schedule` (under `EventConfig.titleSlides`);
// this module groups the helpers callers actually use day-to-day. Pure
// module — no vscode imports.

export type {
  TitleSlidesBinding,
  TitleSlideFieldBinding,
} from '../schedule';

import type {
  TitleSlidesBinding,
  TitleSlideFieldBinding,
} from '../schedule';

export type SpeakerFieldBinding = Extract<TitleSlideFieldBinding, { role: 'speaker' }>;

/**
 * Speaker capacity per slide — the count of `role: 'speaker'` entries.
 * The pagination layer uses this to decide when to spill into a second slide.
 */
export function titleSlideCapacity(binding: TitleSlidesBinding): number {
  let n = 0;
  for (const f of binding.fields) if (f.role === 'speaker') n++;
  return n;
}

/**
 * Group fields by role for the renderer. Single-role entries return the
 * first binding for that role (multiple bindings of the same single-value
 * role would be a binding-UI bug, last one wins here for safety). Speakers
 * are returned in source-list order — pagination preserves this so
 * speaker N from the schedule lands in speakers[N] on the slide.
 */
export function titleSlideFieldsByRole(binding: TitleSlidesBinding): {
  sessionTitle?: TitleSlideFieldBinding;
  roomName?: TitleSlideFieldBinding;
  timeslot?: TitleSlideFieldBinding;
  day?: TitleSlideFieldBinding;
  speakers: SpeakerFieldBinding[];
} {
  const out: ReturnType<typeof titleSlideFieldsByRole> = { speakers: [] };
  for (const f of binding.fields) {
    if (f.role === 'speaker') out.speakers.push(f);
    else out[f.role] = f;
  }
  return out;
}
