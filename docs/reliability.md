# Reliability and recovery changes

## Sending and drafts

New clients attach a stable request ID to each send. The backend durably writes
the encrypted queue before acknowledging it; repeating a request returns the
original job, and reusing its ID with different content returns HTTP 409.
Receipts survive removal of finished jobs. These receipts retain identifiers
and summaries indefinitely, but not message bodies. Queue history retains up
to 100 events per job; sent and cancelled jobs are pruned after 30 days.

Connection failures known to precede delivery and explicit transient provider
rejections can retry automatically. Lost responses and interrupted sends become
**Delivery uncertain**. Check the provider's Sent folder before choosing **Retry
anyway**: no client can guarantee exactly-once SMTP delivery after a lost
acknowledgement. **Sent** means the provider accepted the message, not that the
recipient received it. Follow-up clocks now begin at provider acceptance.

Desktop and browser drafts and offline sends use AES-GCM encrypted IndexedDB.
Electron derives its storage key from the OS-protected master key. A standalone
browser asks for a separate storage passphrase (at least 12 characters), derives
a key with PBKDF2, and keeps that key only in memory. Preserve the passphrase:
there is no reset that can recover encrypted drafts. Existing plaintext browser
records are removed only after encrypted migration succeeds. Quota failures
preserve the open composer; older unsent items are never evicted to make room.
Rejected offline requests remain visible and require a manual retry.

Mobile drafts autosave locally, including attachments, and appear under
**Settings > Local drafts**. Files use AES-GCM with a SecureStore key. Updates
publish a new encrypted version before cleaning up old versions. Drafts are
filtered by backend URL. Explicit Save also saves to the provider's Drafts
folder. Mobile sends require a backend connection; failed submissions preserve
the draft for retry. Picked files are limited to 15 MB each and 25 MB combined
base64 content. Mobile plaintext is escaped before being rendered as HTML.

Outbox entries can be edited and rescheduled while pending, retrying, failed,
or cancelled. Editing the body uses plain text; leaving it untouched preserves
existing HTML. Attachments remain attached. Sending, sent, and uncertain entries
cannot be edited. Undo cancels a job and keeps it in Outbox for recovery.

## Synchronization, rules, and access

Sync status shows per-account progress, last success, errors, and the number of
locally indexed messages, with a manual retry action. Inbox polling paginates
beyond the former 25-message limit and stores checkpoints across restarts. The
first sync establishes a baseline without applying arrival rules to historical
mail. Subsequent syncs process newly observed messages. A repeated page token or
the 100,000-message safety limit surfaces an error without advancing the
checkpoint. This is a full inbox scan, so very large mailboxes may consume
significant provider quota. Search covers indexed messages, not an assurance
that every folder has been downloaded. Unicode word segmentation supports CJK.

Rule previews list matching subjects, senders, and actions without applying
changes, including for disabled rules. Previews use the supplied sample (loaded
messages on desktop and fetched inbox pages on mobile), not the entire mailbox.
Preview again after changing conditions or actions.

Device access tokens can be created and revoked using the master API token in
the recovery settings. The secret is displayed once; the backend stores its hash.
Device tokens grant access to the connected backend's accounts, but cannot
create, list, or revoke other access tokens. Revocation rejects new requests,
closes that device's event streams, and removes linked push registrations.
Requests already executing may complete. Existing master-token clients remain
supported; migrate each device to its own token for independent revocation.

Unsubscribe requests reject private IPv4 and IPv6 destinations, including mapped
IPv6 forms, and pin the validated DNS address for the HTTPS connection. Redirects
are not followed or reported as success; only a successful HTTP response counts.

## Validation and remaining limits

Run with Node 24 and install from each directory's lockfile using `npm ci`:

- `desktop/backend`: `npm test` (290 backend tests).
- `desktop/frontend`: `npm run build`, `npx playwright install chromium`, then
  `npm run test:ui` (five browser workflows, with mocked providers).
- `app`: `npm run typecheck`, `npm test` (four composer workflows),
  `npx expo install --check`, and
  `npx expo export --platform android --platform ios --output-dir dist`.

The mobile app now uses Expo 57 / React Native 0.86 / React 19. Native builds
must be rebuilt after upgrading; JavaScript bundle exports do not substitute
for signed builds, physical-device push checks, or live-provider testing.
CI runs these checks on pushes and pull requests.

The 2026-10-12 dependency audit reports zero backend findings and zero production
frontend findings. Remaining full-tree findings are five high findings in the
frontend, eight moderate in desktop packaging, and 52 in the mobile tree (47
high, five moderate), with no critical findings. These counts include dependent
packages affected by the same underlying advisory. The remaining roots are
`braces` (GHSA-vfj7-8cjw-p6xm), `sprintf-js` (GHSA-hp3w-g68c-fv3c), and
`node-forge` (GHSA-86w9-cpqp-85rv) in Expo tooling. Mobile's npm production tree also includes build
tooling, so it is not audit-clean. Unsafe automatic framework downgrades were
not applied. Re-run audits as upstream fixes become available; do not treat this
review as proof that the project has no undiscovered issues.
