const express = require('express');
const router = express.Router();
const store = require('../store');
const pgp = require('../services/pgpService');

// OpenPGP key management.
//
// GET    /api/pgp/keys                          identities and contact keys (no private keys)
// POST   /api/pgp/identities                    { email, name } make a key pair,
//                                               or { email, armoredKey, passphrase } import one
// GET    /api/pgp/identities/:email/public      the public key, to share
// POST   /api/pgp/identities/:email/export      { passphrase } a protected private-key backup
// DELETE /api/pgp/identities/:email
// POST   /api/pgp/contacts                      { armoredKey } import public key(s)
// POST   /api/pgp/contacts/from-attachment      { accountId, emailId, index, folder }
// DELETE /api/pgp/contacts/:email
// POST   /api/pgp/identities/:email/passphrase  { passphrase, enabled } require a passphrase (or stop)
// POST   /api/pgp/unlock                        { email?, passphrase, hours? } unlock for a while
// POST   /api/pgp/lock                          { email? } forget unlocked keys now
// GET    /api/pgp/public-keys                   every public key known here (for on-device crypto)
// POST   /api/pgp/readiness                     { from, to, cc, bcc } can this message be signed/encrypted?
//
// Private-key routes are master-token only (middleware/deviceScope.js).

const fail = (res, err, status = 400) => res.status(status).json({ error: err.message || String(err) });

router.get('/keys', async (req, res) => {
  try { res.json(await pgp.listKeys()); } catch (err) { fail(res, err, 500); }
});

router.post('/identities', async (req, res) => {
  const { email, name, armoredKey, passphrase } = req.body || {};
  try {
    const identity = armoredKey
      ? await pgp.importIdentity({ email, armoredKey, passphrase })
      : await pgp.generateIdentity({ email, name });
    res.status(201).json(identity);
  } catch (err) { fail(res, err); }
});

router.get('/identities/:email/public', (req, res) => {
  const entry = store.getPgpKeys().identities[String(req.params.email).toLowerCase()];
  if (!entry) return res.status(404).json({ error: 'No key for that address' });
  const safe = String(req.params.email).replace(/[^a-z0-9@._-]/gi, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.asc"`);
  res.type('application/pgp-keys').send(entry.publicKey);
});

router.post('/identities/:email/export', async (req, res) => {
  try {
    const armored = await pgp.exportIdentity(req.params.email, req.body?.passphrase);
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ armoredKey: armored });
  } catch (err) { fail(res, err); }
});

// Require (or stop requiring) a passphrase for this key. Master token only.
router.post('/identities/:email/passphrase', async (req, res) => {
  const { passphrase, enabled, hours } = req.body || {};
  try {
    res.json(enabled === false
      ? await pgp.removePassphrase(req.params.email, passphrase)
      : await pgp.requirePassphrase(req.params.email, passphrase, { hours }));
  } catch (err) { fail(res, err); }
});

router.delete('/identities/:email', (req, res) => {
  pgp.removeIdentity(req.params.email);
  res.json({ success: true });
});

router.post('/contacts', async (req, res) => {
  try { res.status(201).json({ imported: await pgp.importContactKeys(req.body?.armoredKey) }); }
  catch (err) { fail(res, err); }
});

// "Import key" on an application/pgp-keys attachment.
router.post('/contacts/from-attachment', async (req, res) => {
  const { accountId, emailId, index, folder } = req.body || {};
  const account = store.getAccount(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const { loadAttachment } = require('./emails')._internals;
    const attachment = await loadAttachment(account, String(emailId), Number(index), folder, { pgp: req.body?.pgp === true });
    const text = Buffer.from(attachment.content || '').toString('utf8');
    res.status(201).json({ imported: await pgp.importContactKeys(text, { source: 'attachment' }) });
  } catch (err) { fail(res, err); }
});

router.delete('/contacts/:email', (req, res) => {
  pgp.removeContact(req.params.email);
  res.json({ success: true });
});

// Unlock a passphrase-protected key for a while. Any device may do this:
// knowing the passphrase is the authority, and it changes nothing stored.
// Without an email, every locked key that passphrase opens.
router.post('/unlock', async (req, res) => {
  const { email, passphrase, hours } = req.body || {};
  try { res.json(await pgp.unlockIdentity({ email, passphrase, hours })); }
  catch (err) { res.status(err.code === 'PGP_BAD_PASSPHRASE' ? 403 : 400).json({ error: err.message, code: err.code }); }
});

router.post('/lock', (req, res) => res.json(pgp.lockNow(req.body?.email)));

// Public keys only, for a client that encrypts and verifies on its own.
router.get('/public-keys', (req, res) => res.json({ keys: pgp.publicKeys() }));

router.post('/readiness', (req, res) => {
  const { from, to, cc, bcc } = req.body || {};
  res.json(pgp.readiness({ from, to, cc, bcc }));
});

module.exports = router;
