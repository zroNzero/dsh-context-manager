import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'

const root = 'C:/Users/zro_0/.dsh/sessions'
const files = []
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.zstd')) files.push(p)
  }
}
walk(root)
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)

for (const target of files.slice(0, 2)) {
  const buf = fs.readFileSync(target)
  let text
  try {
    text = zlib.zstdDecompressSync(buf).toString('utf8')
  } catch {
    console.log(path.basename(path.dirname(target)), '-> decompress failed')
    continue
  }
  const occurrences = [...text.matchAll(/effort/gi)]
  console.log('=== ' + path.basename(path.dirname(target)) + ' ===')
  console.log('size', text.length, 'effort hits', occurrences.length)
  const contexts = new Set()
  for (const m of occurrences.slice(0, 200)) {
    const s = Math.max(0, m.index - 70)
    contexts.add(text.slice(s, m.index + 40).replace(/\s+/g, ' '))
  }
  for (const c of [...contexts].slice(0, 6)) console.log('  …' + c + '…')
}
