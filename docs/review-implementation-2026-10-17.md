# Review implementation — 17 October 2026

Implemented by Codex following the [project review](project-review-2026-10-17.md).

## Fixes

| Finding | Implementation |
| --- | --- |
| Mobile remote-image bypass | Parse and sanitize with htmlparser2, serialize the sanitized DOM, and independently enforce image sources in the viewer. Regression tests cover duplicate attributes, encoded URLs, and active content. |
| Blocking regex rules | RE2JS replaces synchronous backtracking regex evaluation. Unsupported backreferences and lookarounds fail closed; existing rules using those constructs need rewriting. |
| Desktop draft loss | Encrypted local autosave after a 600 ms pause, visible save status, serialized writes, and recovery after reload. Sending and discarding coordinate with outstanding saves. |
| Destructive provider draft replacement | Save the replacement and encrypted shared record before deleting the previous provider copy. Failed cleanup may leave an extra recoverable provider draft. |
| Missed polling retries | Advance the newest-message marker only after a successful scan; retry incomplete scans on subsequent polling ticks. Fix iterator handling in cached inbox scans. |
| Private data in release inputs | Exclude cache directories, state, and shared drafts from Electron and Docker. Add Electron filter checks and Windows packaging CI. Include required app icons. |
| Expo compatibility | Align Expo, crypto, notifications, and jest-expo with the installed SDK's compatible versions. |
| Dependency advisories | Add install-time guards and executable regression checks for the remaining unpatched tooling dependencies; details below. |

## Added features and use

- **Send checks:** missing-attachment warnings appear before delivery. Enable **Check recipients** in the composer for unfamiliar recipients, external domains, and sender mismatch warnings. These are heuristics; users can proceed after reviewing them.
- **Mobile offline mail:** successful account, folder, list, and message reads are cached with authenticated encryption. A banner identifies saved mail used during connection failures. The cache retains up to 100 API results, not an entire mailbox. Authentication failures do not fall back to cached data.
- **Mobile offline outbox:** failed transport/server requests can be saved durably on the phone using the same request ID. Outbox distinguishes local messages from server-accepted jobs, supports retry/removal, and retains rejected messages. The app retries on foreground activation and every 30 seconds while mounted; this is not an OS background delivery service. Limits are 20 pending messages and 100 MB of serialized cache/queue data. Connection URL and token isolate cached data and queues. A lost response may mean a send was already accepted; removing a local entry cannot recall it from the server. A provider draft may remain after an offline send.
- **Shared drafts:** explicit Save writes an encrypted shared snapshot and provider draft. Choose **Load shared drafts** on another client connected to the same backend. Revision checks reject stale edits; local conflicts are preserved separately, and **Save as new shared draft** creates an independent copy. Recipients, content, attachments, and reply references are retained. Mobile edits use plain text, so desktop rich formatting is not preserved after editing on mobile. Independent backend installations do not share this state. Local autosave is not continuous server synchronization.
- **Search coverage:** recovery settings now show retained summaries, indexed bodies, and date bounds by folder. Select an account, folder, and optional date range to backfill bodies. Counts describe retained documents, not guaranteed complete coverage. The default index limit is 50,000 messages and 20,000 body characters per message. Backfills stop at 100,000 scanned messages or a repeated provider page token. One job runs per account; progress jobs are in memory and must be restarted after a backend restart, while indexed content persists.
- **AI privacy:** recovery settings provide backend-wide local-only mode and per-account opt-in for automatic draft completion. Automatic completion defaults off. Manual draft assistance previews its subject, body, instructions, and reply context before a request. Local-only mode blocks external AI routes and background AI settings; it does not disable normal mail-provider networking. Already dispatched requests cannot be recalled. Per-account opt-in applies to automatic completion, not every existing reader AI feature.

Autosave narrows the crash-loss window; changes within the debounce interval or a failed storage write can still be lost. Save failures remain visible. Missing encryption keys preserve existing files rather than replacing them with empty state.

## Dependency mitigation and maintenance

`scripts/patch-tooling.cjs` runs through the desktop, frontend, and mobile `postinstall` hooks and their `test:security` commands. It applies source guards without changing package versions, verifies ordinary behavior and exploit regressions, and rejects unexpected source layouts:

- [braces nesting exhaustion, GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): bounded parser depth and AST traversal.
- [sprintf-js precision/width exhaustion, GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): bounded numeric formatting parameters.
- [node-forge DigestAlgorithm validation, GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): reject extra or non-NULL algorithm parameters in RSA verification.

These are local mitigations, not upstream fixes or a clean npm audit. The reviewed trees still report frontend 5 high, desktop 8 moderate, and mobile 46 high plus 5 moderate findings; backend reports none. Counts include transitive dependents. Install with lifecycle scripts enabled; if using `--ignore-scripts`, run the appropriate `test:security` before building. Reassess and remove guards when verified upstream releases become available. No framework downgrade or forced audit fix was applied.

## Validation

- Backend: 296 tests pass, including draft conflicts/failure preservation, polling retries, regex limits, AI privacy, and backfill range/pagination handling.
- Desktop: TypeScript and production build pass; all 7 Playwright workflows pass, including encrypted autosave recovery and cancelling missing-attachment delivery.
- Mobile: TypeScript passes; 7 Jest tests and 4 encrypted offline-storage tests pass; Expo compatibility check passes; Android and iOS bundle export passes.
- Tooling guard checks pass for all three dependency trees; frontend clean `npm ci` exercises the install hook.
- Electron packaging filters pass; Windows unpacked application build succeeds. Inspection confirms required services, RE2JS, frontend, and icons are present and private backend state is absent. Packaging is unsigned.
- Git whitespace checks pass.

Live Gmail/Outlook/IMAP delivery, physical-device behavior, native mobile builds, Docker deployment, signed installers, and launching the packaged GUI were not exercised. Provider-mocked tests and bundle/packaging checks do not establish those outcomes. This work addresses the review's concrete findings and proposed features; it is not a guarantee that the entire project has no other defects.
