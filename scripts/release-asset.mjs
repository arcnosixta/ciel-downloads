import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'

const API = 'https://api.github.com'
const CDN = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'])
const MAX_BYTES = 1024 ** 3

async function describe(file) {
  const info = await lstat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error
  })
  if (!info) return null
  if (!info.isFile()) throw new Error('Release asset destination must be a regular file')
  if (info.size > MAX_BYTES) return { size: info.size }
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return { size: info.size, sha256: hash.digest('hex') }
}

function apiHeaders(accept, token) {
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'Ciel-native-release',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
}

async function releaseAsset(repository, tag, name, token) {
  const response = await fetch(`${API}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: apiHeaders('application/vnd.github+json', token), redirect: 'error', signal: AbortSignal.timeout(20000)
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`GitHub release metadata returned HTTP ${response.status}`)
  }
  const release = await response.json()
  if (release.tag_name !== tag || release.draft) throw new Error('Unexpected GitHub release')
  const assets = release.assets?.filter(item => item.name === name) || []
  if (assets.length !== 1 || assets[0].state !== 'uploaded') throw new Error(`Official GitHub release asset missing: ${name}`)
  const asset = assets[0]
  if (!Number.isSafeInteger(asset.id) || asset.id <= 0 || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) {
    throw new Error(`Invalid metadata for GitHub release asset: ${name}`)
  }
  return asset
}

async function assetResponse(initialUrl, token) {
  let url = new URL(initialUrl)
  const signal = AbortSignal.timeout(180000)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      headers: url.origin === API ? apiHeaders('application/octet-stream', token) : {},
      redirect: 'manual', signal
    })
    if (response.status === 200 && response.body) return response
    await response.body?.cancel()
    const location = response.headers.get('location')
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
      throw new Error(`GitHub asset download returned HTTP ${response.status}`)
    }
    url = new URL(location, url)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !CDN.has(url.hostname)) {
      throw new Error('GitHub release asset redirected outside its official CDN')
    }
  }
  throw new Error('Too many GitHub asset redirects')
}

async function saveAsset(url, file, sha256, expectedSize, token) {
  const response = await assetResponse(url, token)
  const hash = createHash('sha256')
  let size = 0
  const check = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length
      if (size > (expectedSize ?? MAX_BYTES)) return done(new Error('Release asset exceeds its expected size'))
      hash.update(chunk)
      done(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body), check, createWriteStream(file, { flags: 'wx' }))
  if (hash.digest('hex') !== sha256 || (expectedSize !== undefined && size !== expectedSize)) {
    throw new Error('Release asset SHA-256 or size mismatch')
  }
  return size
}

export async function downloadReleaseAsset({ repository, tag, name, output, sha256, token = process.env.GH_TOKEN }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w.@-]+$/.test(tag) ||
      !/^[\w.+-]+$/.test(name) || name === '.' || name === '..' || !/^[a-f\d]{64}$/.test(sha256) || !isAbsolute(output)) {
    throw new Error('Invalid pinned release asset specification')
  }
  const cached = await describe(output)
  if (cached?.sha256 === sha256) return { ...cached, output }
  await mkdir(dirname(output), { recursive: true })
  const direct = `https://github.com/${repository}/releases/download/${tag}/${name}`
  const partial = `${output}.${randomUUID()}.part`
  let asset
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!asset) {
      try { asset = await releaseAsset(repository, tag, name, token) }
      catch (error) { lastError = error }
      if (asset?.digest && asset.digest !== `sha256:${sha256}`) throw new Error(`GitHub published an unexpected SHA-256 for ${name}`)
    }
    const urls = asset ? [`${API}/repos/${repository}/releases/assets/${asset.id}?ciel=${randomUUID()}`, direct] : [direct]
    for (const url of urls) {
      try {
        const size = await saveAsset(url, partial, sha256, asset?.size, token)
        await rename(partial, output)
        return { output, sha256, size }
      } catch (error) {
        lastError = error
      } finally {
        await rm(partial, { force: true })
      }
    }
    if (attempt < 3) await delay(attempt * 1500)
  }
  throw new Error(`Could not acquire verified GitHub asset ${repository}@${tag}/${name}: ${lastError.message}`, { cause: lastError })
}
