// Temporary, fail-closed mitigations for advisories without upstream releases.
// Keep package versions unchanged so npm audit continues reporting upstream debt.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(process.argv[2] || process.cwd(), 'node_modules');
let count = 0;
function edit(file, marker, transform) {
  const before = fs.readFileSync(file, 'utf8');
  if (before.includes(marker)) return;
  const after = transform(before);
  if (before === after || !after.includes(marker)) throw new Error('Unsupported dependency source: ' + file);
  fs.writeFileSync(file, after); count++;
}
function visit(modules) {
  if (!fs.existsSync(modules)) return;
  for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = path.join(modules, entry.name);
    if (entry.name.startsWith('@')) { visit(dir); continue; }
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;
    const pkg = JSON.parse(fs.readFileSync(manifest));
    if (pkg.name === 'braces') {
      edit(path.join(dir, 'lib/parse.js'), 'HERMES_DEPTH_LIMIT', s => s.replace('while (index < length) {', "while (index < length) {\n    if (stack.length > 64) throw new RangeError('HERMES_DEPTH_LIMIT: brace nesting exceeds 64');"));
      // Public AST entry points must also reject deep or cyclic caller-supplied ASTs.
      for (const name of ['compile', 'expand', 'stringify']) {
        edit(path.join(dir, 'lib/' + name + '.js'), 'HERMES_AST_LIMIT', s => s.replace(/((?:const (?:compile|expand) =|module\.exports =) \(ast, options = \{\}\) => \{)/, `$1
  // HERMES_AST_LIMIT
  const pending = [[ast, 0]];
  let visited = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > 64 || ++visited > 100000) throw new RangeError('Brace AST limit exceeded');
    for (const child of node.nodes || []) pending.push([child, depth + 1]);
  }`));
      }
      const braces = require(dir);
      assert.throws(() => braces('{'.repeat(100) + 'a,b' + '}'.repeat(100)), /LIMIT|limit/);
      assert.deepEqual(braces.expand('x{a,b}'), ['xa', 'xb']);
    }
    if (pkg.name === 'sprintf-js') {
      edit(path.join(dir, 'src/sprintf.js'), 'HERMES_FORMAT_LIMIT', s => s.replace('else if ((match = re.placeholder.exec(_fmt)) !== null) {', `else if ((match = re.placeholder.exec(_fmt)) !== null) {
                // HERMES_FORMAT_LIMIT: cap allocation and numerical precision before formatting.
                if (Number(match[6] || 0) > 10000 || Number(match[7] || 0) > 100) throw new RangeError('Format width or precision exceeds limit');`));
      const sprintf = require(dir).sprintf;
      assert.throws(() => sprintf('%1000000000s', 'x'), /limit/);
      assert.throws(() => sprintf('%.1000000000f', 1), /limit/);
      assert.equal(sprintf('%04d', 12), '0012');
    }
    if (pkg.name === 'node-forge') {
      edit(path.join(dir, 'lib/rsa.js'), 'HERMES_DIGEST_SHAPE', s => s.replace('obj.value.length !== 2)', `obj.value.length !== 2 ||
            // HERMES_DIGEST_SHAPE: AlgorithmIdentifier has only OID and optional NULL.
            obj.value[0].value.length < 1 || obj.value[0].value.length > 2 ||
            (obj.value[0].value.length === 2 &&
              (obj.value[0].value[1].type !== asn1.Type.NULL || obj.value[0].value[1].constructed || obj.value[0].value[1].value !== ''))) `));
      // Verify the normal signing/verification path still works after the strict check.
      const forge = require(dir);
      const pair = forge.pki.rsa.generateKeyPair({ bits: 512, workers: 0 });
      const md = forge.md.sha256.create().update('hermes-tooling-check');
      assert.equal(pair.publicKey.verify(md.digest().bytes(), pair.privateKey.sign(md)), true);
      const a = forge.asn1;
      const sha1 = forge.md.sha1.create().update('hermes-invalid-digest');
      const algorithm = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [
        a.create(a.Class.UNIVERSAL, a.Type.OID, false, a.oidToDer(forge.oids.sha1).getBytes()),
        a.create(a.Class.UNIVERSAL, a.Type.NULL, false, ''),
        a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, []),
      ]);
      const malformed = a.create(a.Class.UNIVERSAL, a.Type.SEQUENCE, true, [algorithm,
        a.create(a.Class.UNIVERSAL, a.Type.OCTETSTRING, false, sha1.digest().bytes())]);
      const signature = pair.privateKey.sign(a.toDer(malformed).getBytes(), 'NONE');
      assert.throws(() => pair.publicKey.verify(sha1.digest().bytes(), signature), /DigestInfo/);
    }
    visit(path.join(dir, 'node_modules'));
  }
}
visit(root);
console.log(`Tooling mitigations verified (${count} files patched).`);
