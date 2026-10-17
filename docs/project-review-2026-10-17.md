# Project review — 17 October 2026

Scope: repository review covering the Electron shell, React desktop client, Expo mobile client, Express backend, provider integrations, storage, send queue, synchronization, rendering, deployment, and CI. This is a broad code review with automated checks and targeted reproductions, not a guarantee that every execution path is correct. This document records the original findings before implementation. Fixes, added features, validation, and remaining limits are recorded in [the implementation report](review-implementation-2026-10-17.md).

## Validation

| Check | Result |
| --- | --- |
| Backend `npm test` | 290 passed |
| Desktop frontend `npm run build` | Passed, including TypeScript |
| Desktop Playwright workflows | 5 passed |
| Mobile `npm run typecheck` | Passed |
| Mobile `npm test` | 4 passed |
| Mobile Android and iOS Expo bundle export | Passed |
| `npx expo install --check` | Failed: four packages behind the expected compatible versions |
| Backend npm audit, full tree | 0 findings |
| Frontend npm audit, full tree | 5 high findings |
| Desktop packaging npm audit, full tree | 8 moderate findings |
| Mobile npm audit, full tree | 47 high and 5 moderate findings |

Audit counts include dependent packages affected by the same underlying advisory; they are not counts of independently exploitable application defects. These are fresh npm registry results. No automatic audit fixes were applied: suggested fixes include framework changes and downgrades that need compatibility review.

Live Gmail/Outlook/IMAP delivery, signed installers, Docker deployment, physical-device notifications, and actual native builds were not exercised. Browser workflows mock providers. The mobile export verifies bundling, not device behavior.

## Findings, ordered by priority

### 1. High — mobile remote-image blocking can be bypassed

Location: `app/src/emailHtml.ts:58`, used by `app/src/screens/ViewerScreen.tsx:398`.

The handwritten attribute parser keeps the last duplicate attribute, while the installed HTML parser used by the renderer keeps the first. An email containing:

```html
<img src="https://tracker.example/pixel" src="data:image/png;base64,AAAA" width="200" height="200">
```

passes `sanitizeEmailHtml(input, false)` unchanged, with zero blocked images. Parsing that output with the installed `htmlparser2` gives the remote URL as the effective image source. This permits a tracking request despite the user's remote-image preference. The reproduction inspected sanitizer and parser output; no request was sent.

Fix: parse and sanitize the same DOM representation the renderer consumes, and independently enforce the remote-content policy in the image renderer. Add duplicate-attribute and malformed-markup regressions.

### 2. High — regex mail rules can freeze the backend

Location: `desktop/backend/services/rulesService.js:108`.

The `matches` operator executes a user-defined JavaScript regex synchronously against message headers. Capping the pattern at 200 characters does not bound backtracking. Calling the actual condition matcher with `(a+)+$` and a subject consisting of 30 `a` characters followed by `!` exceeded a one-second VM timeout in an isolated reproduction.

A configured problematic rule can therefore be triggered by incoming mail, blocking API responses, queue processing, and synchronization on the same event loop. This requires a matching rule to exist; arbitrary senders cannot create rules themselves.

Fix: use a regex engine with bounded execution, or isolate evaluation in a worker that can be terminated. A same-thread promise timeout cannot interrupt a synchronous regex.

### 3. High — desktop composition has no continuous crash-recovery save

Location: `desktop/frontend/src/components/ComposeModal.tsx:349`, `:627`, `:667`.

Local draft writes occur on explicit Save or closing the composer through its save handler. Editor updates trigger AI completion but do not persist the draft. A renderer crash, refresh, or application quit while writing can lose a new draft or all changes since the last save. The mobile client already has debounced autosaving, but desktop does not.

Fix: autosave recipients, body, attachments, and reply metadata to encrypted storage as the composition changes; show saving/failure status and recover the latest durable version on restart. Test reload during composition, before Send or Close.

### 4. Medium — replacing a server draft deletes the old copy before the new save succeeds

Location: `desktop/backend/routes/emails.js:1353`.

For a request with `replaceRef`, the route calls `deleteDraft` before `saveDraft`. An isolated execution of the actual route with a successful delete and a failing provider save returned HTTP 500 with the old draft already removed. Desktop can fall back to a local copy, but the previously synchronized provider draft is gone and other devices lose access to it.

Fix: create the replacement first, return/store its reference, then delete the old copy; use provider update-in-place when supported. Prefer an extra recoverable draft over deleting the only server copy.

### 5. Medium — API polling does not retry a failed full sync while the newest message is unchanged

Location: `desktop/backend/services/mailWatchService.js:358`, `:366`; fetch failure handling around `:103`.

The poller advances `lastSeenMessageId` before `handleNewMail` finishes. The full scan can then fail and return an empty result with incomplete sync status. On the next timer tick the top message ID is unchanged, so the scan is skipped. Notifications, indexing, and rules can remain incomplete until another top-message change, manual sync, or watcher restart.

An isolated reproduction of the actual polling function with a failed-scan result produced two head polls but only one full-sync attempt.

Fix: make full-scan success explicit, advance the polling marker only after success, and retry incomplete syncs with bounded backoff regardless of the current top ID.

### 6. Medium — release exclusions miss current runtime mail files

Locations: `desktop/package.json:48`, `desktop/backend/.dockerignore:12`, `desktop/backend/store.js:13`.

Runtime cache storage now uses `backend/email-cache/`, with an encrypted index and per-message `.bin` files. Electron packaging and Docker exclusions still name the old `email-cache.json` file but do not exclude the new directory. Docker also does not exclude `state.json`. A build from a development checkout containing runtime data can therefore include those files in the distributed artifact.

These files are encrypted; this is not evidence that plaintext email or decryption keys are included. It is still unintended distribution of private runtime data and unnecessary artifact growth. No actual release artifact was inspected.

Fix: exclude the whole runtime directory and all state files in both packaging systems, preferably keep runtime data outside the source tree, and add an artifact check with synthetic marker files.

### 7. Medium — the mobile compatibility check currently fails

Location: `app/package.json`; enforced in `.github/workflows/ci.yml`.

`npx expo install --check` reported:

| Package | Installed | Expected |
| --- | --- | --- |
| expo | 57.0.27 | ~57.0.30 |
| expo-crypto | 57.0.3 | ~57.0.4 |
| expo-notifications | 57.0.22 | ~57.0.23 |
| jest-expo | 57.0.5 | ~57.0.6 |

The same command is a required mobile CI step. Passing type checks and bundle exports does not make this compatibility check pass.

Fix: align the four packages and lockfile using Expo's compatibility tooling, rerun mobile checks, and rebuild native clients when necessary.

### 8. Medium — dependency audit debt remains outside the backend

Fresh audit results match the unresolved counts already documented in `docs/reliability.md`: frontend tooling, desktop packaging, and the mobile dependency tree still have findings. The affected direct dependency chains include Tailwind, electron-builder, Expo, React Native, and testing tools. Mobile's production dependency tree also contains tooling, so a full-tree count alone does not establish device exploitability.

Fix: track underlying advisories and reachable code separately, upgrade compatible fixes, and explicitly review unresolved tooling exposure. Do not blindly apply `npm audit fix --force` to the suggested framework downgrade paths.

## Features worth adding after the fixes

1. **Send checks:** warn when the text mentions an attachment but none is attached; optionally flag new recipients, external domains, and a work/personal sender mismatch. Keep warnings specific and easy to dismiss.
2. **Mobile offline reading and sending:** encrypted local message summaries/bodies, a local send queue using the existing stable request IDs, and clear queued-versus-accepted status. Mobile drafts are already local; mobile API access still requires the backend.
3. **Cross-device draft continuation:** retain provider draft references on mobile, update existing drafts instead of creating another copy, and surface edit conflicts when two devices work on the same draft. Current mobile Save does not retain the returned provider reference.
4. **Search coverage controls:** show which folders and date ranges are indexed and offer an explicit background backfill. Existing search is useful, but indexed inbox summaries and opened bodies do not constitute a complete mailbox search.
5. **Privacy controls for AI:** per-account opt-in for automatic completion, an explicit preview of text sent to a provider, and a local-only mode. Automatic completion currently sends composition text after a typing pause when AI is configured.

Suggested sequence: fix the image-blocking bypass, regex execution, and draft durability first; then repair sync recovery and packaging; then add send checks and mobile offline support. Add focused regression tests for these failures and a packaged-app smoke check to complement the existing provider-mocked workflows.
