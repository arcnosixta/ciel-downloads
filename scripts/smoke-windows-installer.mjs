// Real registry/install/uninstall tests: run only on a disposable GitHub runner.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
const require = createRequire(import.meta.url)
const { UUID } = require('builder-util-runtime')
const asar = require('@electron/asar')
const execute = promisify(execFile)
assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Installer tests require an isolated GitHub runner')
const pkg = require('./package.json')
const guid = UUID.v5(pkg.build.appId, UUID.parse('50e065bc-3134-11e6-9bab-38c9862bdaf3'))
const registry = 'Software\\' + guid
const location = async hive => {
  try {
    const { stdout } = await execute('reg.exe', ['query', `${hive}\\${registry}`, '/v', 'InstallLocation', '/reg:64'], { windowsHide: true })
    return /InstallLocation\s+REG_SZ\s+(.+)/.exec(stdout)?.[1].trim() || ''
  } catch (error) { if (error.code === 1) return ''; throw error }
}
assert.equal(await location('HKCU'), '', 'Runner already has a user Connector install')
assert.equal(await location('HKLM'), '', 'Runner already has a machine Connector install')
const installer = resolve(`connector/dist/Ciel-Connector-win-${process.arch}.exe`)
const legacy = resolve(process.argv[2] || '')
assert.ok(process.argv[2], 'A verified legacy installer is required')
await access(legacy)
const previous = await fetch('https://api.github.com/repos/arcnosixta/ciel-downloads/releases/tags/v1.0.13')
assert.ok(previous.ok, 'Cannot verify the published legacy installer')
const digest = (await previous.json()).assets.find(asset => asset.name === basename(legacy))?.digest
const hash = createHash('sha256')
for await (const chunk of createReadStream(legacy)) hash.update(chunk)
assert.equal(digest, 'sha256:' + hash.digest('hex'), 'Legacy installer checksum mismatch')
const root = await mkdtemp(join(tmpdir(), 'ciel-installer-upgrade-'))
let installed = ''
const run = async (file, args) => {
  const started = Date.now()
  console.log(`Starting ${basename(file)}: ${args.join(' ')}`)
  const timer = setInterval(() => console.log(`Waiting for ${basename(file)}: ${Math.round((Date.now() - started) / 1000)}s`), 30000)
  try {
    await execute(file, args, { windowsHide: true, windowsVerbatimArguments: true, timeout: 1200000, maxBuffer: 1024 * 1024 })
    console.log(`Finished ${basename(file)}: ${Math.round((Date.now() - started) / 1000)}s`)
  } finally { clearInterval(timer) }
}
const installedVersion = directory => {
  const archive = join(directory, 'resources/app.asar')
  // Upgrades replace the archive at the same path; its old cached header is invalid.
  asar.uncache(archive)
  return JSON.parse(asar.extractFile(archive, 'package.json')).version
}
let uninstallFailed = false
const uninstall = async () => {
  if (!installed) return
  try {
    const mode = await location('HKCU') ? '/currentuser' : '/allusers'
    await run(join(installed, `Uninstall ${pkg.build.productName}.exe`), ['/S', mode])
    // NSIS launches its temporary copy asynchronously. ARM64 removal is slower.
    const deadline = Date.now() + 180000
    while (await location('HKCU') || await location('HKLM')) {
      assert.ok(Date.now() < deadline, 'Uninstall did not remove the registered installation')
      await delay(1000)
    }
    console.log('Verified uninstall removed both registry locations')
    installed = ''
  } catch (error) {
    uninstallFailed = true
    throw error
  }
}
let failed = false
try {
  await run(installer, ['/S'])
  installed = await location('HKCU')
  assert.ok(installed, 'Fresh one-click installation must select the current user')
  assert.equal(await location('HKLM'), '')
  assert.equal(installedVersion(installed), pkg.version)
  console.log('Verified fresh per-user installation')
  await uninstall()
  for (const mode of ['currentuser', 'allusers']) {
    const directory = join(root, mode + ' with spaces')
    await run(legacy, ['/S', `/${mode}`, `/D=${directory}`])
    installed = directory
    const hive = mode === 'currentuser' ? 'HKCU' : 'HKLM'
    const other = hive === 'HKCU' ? 'HKLM' : 'HKCU'
    assert.equal(resolve(await location(hive)), resolve(directory))
    assert.equal(await location(other), '')
    assert.notEqual(installedVersion(directory), pkg.version)
    console.log(`Verified legacy ${mode} installation`)
    // No /D or mode flag: the new one-click installer must inherit the legacy scope/path.
    await run(installer, ['/S'])
    assert.equal(resolve(await location(hive)), resolve(directory), 'Upgrade changed the registered installation path')
    assert.equal(await location(other), '', 'Upgrade created a second installation in the other scope')
    assert.equal(installedVersion(directory), pkg.version)
    console.log(`Verified ${mode} upgrade preserved version, path and scope`)
    await uninstall()
  }
  console.log(`PASS Windows ${process.arch}: fresh per-user setup, legacy per-user/all-users upgrade paths and uninstall`)
} catch (error) {
  failed = true
  console.error('Installer verification failed:', error)
  throw error
} finally {
  // Do not hide the original failure or launch a competing temporary uninstaller.
  if (!uninstallFailed) try { await uninstall() } catch (error) { console.error('Cleanup failed:', error); if (!failed) process.exitCode = 1 }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  assert.ok(basename(root).startsWith('ciel-installer-upgrade-'))
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(error => { console.error('Temporary directory cleanup failed:', error); process.exitCode = 1 })
}
