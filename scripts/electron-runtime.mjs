import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join } from 'node:path'
import { downloadReleaseAsset } from './release-asset.mjs'

const VERSION = '41.10.6'
const TAG = `v${VERSION}`
// Electron's official release asset digests, independently shipped in npm's checksums.json.
const archiveDigests = {
  'darwin-arm64': '659ba4253ca14f0bd8e74d5a2da2d6da3e73e44c0209d2c3b5e6ca65ac40558a',
  'darwin-x64': 'f14ae7c48551a1b025effb6d4c921bd05f2f5b8c50d72f3710815726f294ce56',
  'linux-arm64': '9dbb040d575c33f8b2d2ab944e429979b01b5261c0240cff4749892be1bc56ea',
  'linux-x64': 'a27291d502b16170fe49d14beab68c4d9a1040192500e1643a9ab0b11274f075',
  'win32-arm64': '5bdf5593f47fc88201010a95093ed87564a222326360cf2afd7637ff795d9825',
  'win32-x64': '5447c50d196c2227e396716ea969869c1e5baa12b6af7fb33f75ae897a6853aa'
}
const checksumFile = 'SHASUMS256.txt'
const checksumDigest = 'aa76f14b03e3e5553ee6c37527c449eb54e25eadf89b8c944ca894b80e6be2ba'
// The release targets use these checksums from app-builder-lib/dmg-builder 26.15.3.
const toolDigests = {
  '7zip@1.0.0/7zip-darwin-arm64.tar.gz': '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1',
  '7zip@1.0.0/7zip-darwin-x86_64.tar.gz': '496a341abe210aae1a25bc202ee97f6de6c76a3dc80f91d96616be05502d72c1',
  '7zip@1.0.0/7zip-linux-arm64.tar.gz': '5aff5034206b78f8261249ceb922b5c7e04c9bdb733784d8f5b6df9732cf1f79',
  '7zip@1.0.0/7zip-linux-x64.tar.gz': 'd151bb44b2a9d9bfc52813ce4cac042916394a0ab8a56bd5d221a5dc9ef8d5d7',
  '7zip@1.0.0/7zip-win-arm64.tar.gz': 'ac3f38f96ce7498096a123bb0862dd6db863a7353c9e9e1c15f73c183adf6620',
  '7zip@1.0.0/7zip-win-x64.tar.gz': 'be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3',
  'appimage-12.0.1/appimage-12.0.1.7z': 'd12ff7eb8f1d1ec4652ca5237a7fbdca33acc0c758045636feca62dc6ecb8ec4',
  'fpm@2.1.4/fpm-1.17.0-ruby-3.4.3-linux-amd64.7z': '44b0ec6025c14ec137f56180e62675c0eae36233cdce53d0953d9c73ced8989f',
  'fpm@2.1.4/fpm-1.17.0-ruby-3.4.3-linux-arm64v8.7z': '338b50cfa7f12d745a997d1a3d000bcd0410008050fa7d8c4476a78a61c0564e',
  'dmg-builder@1.2.5/dmgbuild-bundle-arm64-75c8a6c.tar.gz': '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb',
  'dmg-builder@1.2.5/dmgbuild-bundle-x86_64-75c8a6c.tar.gz': '1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433',
  'icons@1.1.0/icons-bundle.tar.gz': '2241c9501aa5ddd19317956449f50a1bc311df2c34058aae9bf8bfe62081eaec',
  'winCodeSign-2.6.0/winCodeSign-2.6.0.7z': 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4',
  'nsis-3.0.4.1/nsis-3.0.4.1.7z': '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa',
  'nsis-resources-3.4.1/nsis-resources-3.4.1.7z': '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
}

async function prepare() {
  assert.ok(isAbsolute(process.env.RUNNER_TEMP || ''), 'Expected the absolute GitHub runner temporary directory')
  const manifest = JSON.parse(await readFile('package.json', 'utf8'))
  assert.equal(manifest.devDependencies.electron, VERSION, 'The Connector Electron pin must match the verified release')
  assert.equal(manifest.devDependencies['electron-builder'], '26.15.3', 'The packaging tool pin must match the verified assets')
  const platform = `${process.platform}-${process.arch}`
  const sha256 = archiveDigests[platform]
  assert.ok(sha256, `Unsupported Electron build platform: ${platform}`)
  const archive = `electron-${TAG}-${platform}.zip`
  const dir = join(process.env.RUNNER_TEMP, 'ciel-electron', TAG)
  const acquire = (name, digest) => downloadReleaseAsset({ repository: 'electron/electron', tag: TAG, name, output: join(dir, name), sha256: digest })
  const checksums = await acquire(checksumFile, checksumDigest)
  const checksumLines = (await readFile(checksums.output, 'utf8')).split(/\r?\n/)
  assert.ok(checksumLines.some(line => {
    const [digest, name] = line.trim().split(/\s+/, 2)
    return digest === sha256 && name?.replace(/^\*/, '') === archive
  }), 'Official Electron checksum file disagrees with the pinned native ZIP digest')
  const binary = await acquire(archive, sha256)
  console.log(`Verified Electron ${TAG} ${platform} (${binary.size} bytes, SHA-256 ${sha256})`)
  return new Map([[archive, binary], [checksumFile, checksums]])
}

async function runWithMirror(args, assets) {
  const downloads = new Map()
  const server = createServer(async (request, response) => {
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end()
      return
    }
    const prefix = `/${TAG}/`
    let asset = request.url?.startsWith(prefix) && assets.get(request.url.slice(prefix.length))
    const toolPath = request.url?.startsWith('/builder/') && request.url.slice('/builder/'.length).replaceAll('%40', '@')
    if (!asset && toolPath && Object.hasOwn(toolDigests, toolPath)) {
      if (!downloads.has(toolPath)) {
        const [tag, name] = toolPath.split('/')
        const pending = downloadReleaseAsset({
          repository: 'electron-userland/electron-builder-binaries', tag, name, sha256: toolDigests[toolPath],
          output: join(process.env.RUNNER_TEMP, 'ciel-electron', 'builder', tag, name)
        }).catch(error => {
          downloads.delete(toolPath)
          throw error
        })
        downloads.set(toolPath, pending)
      }
      try {
        asset = await downloads.get(toolPath)
      } catch (error) {
        console.error(error.message)
        response.writeHead(502).end()
        return
      }
    }
    if (!asset) {
      console.error(`Unexpected Electron mirror asset: ${request.url}`)
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': asset.size })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const file = createReadStream(asset.output)
    file.once('error', error => response.destroy(error))
    response.once('close', () => file.destroy())
    file.pipe(response)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  try {
    const npm = join(dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js')
    assert.ok((await stat(npm)).isFile(), 'Missing npm from the runner Node.js toolchain')
    const mirror = `http://127.0.0.1:${server.address().port}/`
    const env = {
      ...process.env,
      ELECTRON_MIRROR: mirror,
      ELECTRON_BUILDER_BINARIES_MIRROR: mirror + 'builder/',
      ELECTRON_BUILDER_BINARIES_ALLOW_HTTP: 'true',
      NO_PROXY: [process.env.NO_PROXY || process.env.no_proxy, '127.0.0.1'].filter(Boolean).join(',')
    }
    // electron-builder's older HTTP agent does not consult NO_PROXY.
    for (const name of Object.keys(env)) if (['http_proxy', 'gh_token'].includes(name.toLowerCase())) delete env[name]
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [npm, ...args], { env, stdio: 'inherit', windowsHide: true })
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`npm ${args[0]} exited with ${signal || code}`))
      })
    })
  } finally {
    server.close()
    server.closeAllConnections()
  }
}

const [command, ...args] = process.argv.slice(2)
assert.ok(command === 'prepare' && args.length === 0 || command === 'npm' && args.length, 'Use prepare or npm <arguments>')
const assets = await prepare()
if (command === 'npm') await runWithMirror(args, assets)
