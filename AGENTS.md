<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Contextual tutorial maintenance

The app teaches features with small contextual tips (`src/lib/tutorial.ts` for definitions and eligibility, `src/components/tutorial/` for the coordinator, `TipAnchor` and triggers).

- Whenever you add or materially change a user-facing feature, assess whether it introduces a concept or workflow that needs contextual guidance.
- When guidance is useful, add or update the tip in the same change. Don't create tips for obvious controls, cosmetic changes or internal implementation details.
- Integrate with the shared system: trigger on a meaningful first interaction (never mount, hover or focus alone), check eligibility from effective permissions in the anchor's facts, and keep persistence, accessibility and dismissal behaviour (Got it, close, Escape, outside click; "Turn off tips") intact.
- When changing or removing a feature, update or remove its tips and anchors so guidance never becomes misleading or orphaned.
- Keep tip ids stable for copy edits. Bump a tip's `version` only when the workflow changes enough that people who dismissed the old tip need fresh guidance.
- Verify tips appear only for eligible users and stay compatible with existing progress and the "Turn off tips" preference (`src/lib/tutorial.test.ts`, `src/components/tutorial/coordinator.test.ts`).
- In the completion summary for user-facing changes, state whether tutorial guidance was added, updated or unnecessary, with a brief reason.

## Mobile support

Every user-facing change must work on phones and tablets, not just desktop.

- Check new or changed screens at 320×640 and 390×844 (phone), 844×390 (phone landscape), 768×1024 (tablet), a short desktop window (about 1280×520) and 1280/1920 desktop. Look for sideways scrolling, controls pushed off screen or clipped by scroll containers, text spilling out of its control, and overlapping header groups.
- Touch targets are at least 24×24 px (use `.touch-target` for small icon buttons). Don't hide essential controls behind hover only.
- Give every drag or hover interaction a touch alternative (a tap that opens a menu or dialog, or a list instead of a grid), as the timeline and calendar do on phones.
- Popovers, menus and dialogs must fit the viewport: cap their height (`max-h-[var(--radix-popover-content-available-height)]` plus `collisionPadding`), scroll the body and keep primary and reset actions visible.
- Dialogs and sheets must work with the on-screen keyboard. Avoid fixed heights that hide the focused field or the submit button.
- Verify in a real browser with a phone viewport and touch enabled (Playwright `isMobile`/`hasTouch`) on the isolated verification instance, and test tapping, not just layout. Emulation doesn't replace a real device; say so when something hasn't been checked on one.
- In the completion summary for user-facing changes, state what was checked on mobile (sizes and interactions) and anything left unverified.
