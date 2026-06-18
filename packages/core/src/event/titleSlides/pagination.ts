// Pure pagination for session speakers across template slide copies.
//
// Given N speakers in a session and a per-slide capacity C, produce one
// array of speakers per generated slide. Two modes:
//
//   distributeEvenly = false (default)
//     Fill from the start to C per page; the last page takes the
//     remainder. 5 speakers @ C=4 → [4, 1].
//
//   distributeEvenly = true
//     Spread speakers across pages so per-page counts differ by at most 1.
//     5 speakers @ C=4 → [3, 2]. 7 @ C=4 → [4, 3]. 10 @ C=4 → [4, 3, 3].
//
// Edge cases:
//   - capacity <= 0 → returns [].  (Caller should refuse to generate; the
//     binding has no speaker slots labelled.)
//   - speakers.length === 0 → returns [[]]. One slide with no speakers
//     filled in; non-speaker fields (session title, room, timeslot) still
//     get substituted. This is what a "session with no speakers yet"
//     should look like, not a failure.

import type { SessionSpeakerSlot } from '../schedule';

export function splitSpeakers(
  speakers: SessionSpeakerSlot[],
  capacity: number,
  distributeEvenly: boolean,
): SessionSpeakerSlot[][] {
  if (capacity <= 0) return [];
  if (speakers.length === 0) return [[]];
  if (speakers.length <= capacity) return [speakers.slice()];

  const totalPages = Math.ceil(speakers.length / capacity);

  if (!distributeEvenly) {
    // Fill page 1..n-1 to `capacity`; last page takes the remainder.
    const pages: SessionSpeakerSlot[][] = [];
    for (let p = 0; p < totalPages; p++) {
      const start = p * capacity;
      pages.push(speakers.slice(start, start + capacity));
    }
    return pages;
  }

  // distributeEvenly: base = floor(N / pages); first `extra` pages get base+1.
  const base = Math.floor(speakers.length / totalPages);
  const extra = speakers.length - base * totalPages;
  const pages: SessionSpeakerSlot[][] = [];
  let cursor = 0;
  for (let p = 0; p < totalPages; p++) {
    const take = base + (p < extra ? 1 : 0);
    pages.push(speakers.slice(cursor, cursor + take));
    cursor += take;
  }
  return pages;
}
