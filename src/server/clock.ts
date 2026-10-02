/**
 * Single source of "now" for records created by services. Seeds and tests can
 * pin the clock to produce realistic back-dated histories; production never does.
 */
let pinned: Date | null = null;

export function now(): Date {
  return pinned ? new Date(pinned) : new Date();
}

export function pinClock(date: Date | null) {
  pinned = date ? new Date(date) : null;
}

export function advanceClock(ms: number) {
  if (pinned) pinned = new Date(pinned.getTime() + ms);
}
