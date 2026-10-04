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
