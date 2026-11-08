import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { downloadReleaseAsset } from './release-asset.mjs'

const ffmpeg = {
  url: 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip',
  sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
}

async function acquire(item, output) {
  const url = new URL(item.url)
  const [, repository, tag, name] = /^\/([\w.-]+\/[\w.-]+)\/releases\/download\/([^/]+)\/([^/]+)$/.exec(url.pathname) || []
  if (url.origin !== 'https://github.com' || !repository) throw new Error('Expected a pinned GitHub release asset')
  const result = await downloadReleaseAsset({ repository, tag: decodeURIComponent(tag), name: decodeURIComponent(name), output, sha256: item.sha256 })
  console.log(`Verified ${decodeURIComponent(name)} (${result.size} bytes)`)
}

if (process.argv[2] === '--ffmpeg') {
  if (!process.argv[3]) throw new Error('Specify the destination for the FFmpeg test archive')
  await acquire(ffmpeg, resolve(process.argv[3]))
} else {
  const source = resolve(process.argv[2] || process.cwd())
  const target = `${process.platform}-${process.arch}`
  const read = async name => JSON.parse(await readFile(join(source, name), 'utf8'))
  const [toolchains, osint, speech, { packages }] = await Promise.all([
    read('connector/toolchains.json'), read('server/osint-toolchains.json'), read('connector/speech.lock.json'),
    import(pathToFileURL(join(source, 'server/osint-packages.js')).href),
  ])
  const [jq, sha256] = packages[target]
  const assets = [toolchains[target].git, ...Object.values(osint.platforms[target]), speech.targets[target],
    { url: `https://github.com/jqlang/jq/releases/download/jq-1.8.2/${jq}`, sha256 }]
    .filter(item => item?.url?.startsWith('https://github.com/') && item.sha256)
  const cache = join(source, 'connector/.runtime-cache')
  for (let index = 0; index < assets.length; index += 3) {
    await Promise.all(assets.slice(index, index + 3).map(item => acquire(item, join(cache, basename(new URL(item.url).pathname)))))
  }
}
