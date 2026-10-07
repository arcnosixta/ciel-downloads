const { createCipheriv, createDecipheriv, createHash, randomBytes } = require('node:crypto')
const assert = require('node:assert/strict')

function encryptInput(archive, key, metadata) {
  assert.equal(key.length, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(JSON.stringify(metadata)))
  const data = Buffer.concat([cipher.update(archive), cipher.final()])
  return Buffer.from(JSON.stringify({ metadata, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }))
}

function decryptInput(input, key, expected, sha256) {
  assert.equal(createHash('sha256').update(input).digest('hex'), sha256, 'Build input checksum mismatch')
  assert.equal(key.length, 32, 'Missing build input key')
  const envelope = JSON.parse(input)
  assert.deepEqual(envelope.metadata, expected, 'Build input source/version mismatch')
  const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64')
  assert.equal(iv.length, 12); assert.equal(tag.length, 16)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAAD(Buffer.from(JSON.stringify(envelope.metadata)))
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()])
}

module.exports = { encryptInput, decryptInput }

if (require.main === module) {
  const { readFileSync, writeFileSync } = require('node:fs')
  const { CIEL_BUILD_VERSION: version, CIEL_SOURCE_SHA: sourceSha, CIEL_INPUT_SHA256: sha256, CIEL_BUILD_INPUT_KEY: key } = process.env
  assert.match(version || '', /^\d+\.\d+\.\d+$/)
  assert.match(sourceSha || '', /^[a-f0-9]{40}$/)
  assert.match(sha256 || '', /^[a-f0-9]{64}$/)
  assert.equal(process.argv.length, 4)
  writeFileSync(process.argv[3], decryptInput(readFileSync(process.argv[2]), Buffer.from(key || '', 'base64'), { schema: 1, version, sourceSha }, sha256))
  console.log(`Verified encrypted build input for Ciel ${version} (${sourceSha})`)
}
