// File-drop channel: any plugin (or a shell script) can publish a panel without
// importing this package or calling HTTP, by writing a JSON file into
// $DSH_HOME/.dsh-savings-panels/<producer>.json.
//
// This exists because the filesystem is already DSH's de-facto cross-plugin
// bus: dsh-context-manager writes savings.json, this widget writes
// .dshw-usage.json, and neither imports the other. Watching a directory turns
// that accident into a documented interface.
//
// Rules:
//   - file name (without .json) is the producer id;
//   - the document is either a panel or {panel: panel};
//   - a file that fails to parse is reported once per modification and its
//     last good panel is left untouched (a torn write must not flicker);
//   - deleting the file removes that producer's panels, so removal needs no API.

import fs from 'node:fs'
import path from 'node:path'

import { stripBom } from './schema.js'

export const SPOOL_DIR = '.dsh-savings-panels'
const FILE_RE = /^([a-z0-9][a-z0-9._-]{0,47})\.json$/i

/**
 * @param {object} options
 * @param {string} options.dir directory to watch
 * @param {(producer: string, panel: unknown) => object} options.publish
 * @param {(producer: string) => number} options.clear
 * @param {(level: string, message: string, detail?: object) => void} [options.log]
 */
export function createSpoolSource(options) {
  if (!options || typeof options.dir !== 'string' || typeof options.publish !== 'function' || typeof options.clear !== 'function') {
    throw new TypeError('createSpoolSource requires {dir, publish, clear}')
  }
  const dir = options.dir
  const publish = options.publish
  const clear = options.clear
  const log = typeof options.log === 'function' ? options.log : () => {}
  // Optional: lets the caller force a re-publish when the panel it cached is no
  // longer in the store (expired or evicted) even though the file is unchanged.
  const present = typeof options.present === 'function' ? options.present : () => true

  /** @type {Map<string, {mtimeMs: number, size: number, ok: boolean}>} */
  const seen = new Map()
  let lastError = null
  let published = 0

  function readDir() {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        lastError = String((err && err.message) || err)
        log('warn', 'panel spool directory unreadable', { dir, error: lastError })
      }
      return []
    }
  }

  function poll() {
    const onDisk = new Set()
    let changed = 0

    for (const dirent of readDir()) {
      if (!dirent.isFile()) continue
      const match = FILE_RE.exec(dirent.name)
      if (!match) continue
      const producer = match[1].toLowerCase()
      const full = path.join(dir, dirent.name)
      onDisk.add(producer)

      let stat
      try {
        stat = fs.statSync(full)
      } catch (err) {
        continue
      }
      const before = seen.get(producer)
      if (before && before.mtimeMs === stat.mtimeMs && before.size === stat.size) {
        // An unchanged broken file stays quiet; an unchanged good file is only
        // re-read when its panel is gone from the store.
        if (!before.ok) continue
        if (present(producer)) continue
      }

      let doc
      try {
        doc = JSON.parse(stripBom(fs.readFileSync(full, 'utf8')))
      } catch (err) {
        seen.set(producer, { mtimeMs: stat.mtimeMs, size: stat.size, ok: false })
        lastError = String((err && err.message) || err)
        log('warn', 'panel spool file is not valid JSON; keeping the last good panel', { file: full, error: lastError })
        continue
      }

      const panel = doc && typeof doc === 'object' && doc.panel !== undefined ? doc.panel : doc
      const result = publish(producer, panel)
      if (result && result.ok) {
        seen.set(producer, { mtimeMs: stat.mtimeMs, size: stat.size, ok: true })
        published++
        changed++
      } else {
        seen.set(producer, { mtimeMs: stat.mtimeMs, size: stat.size, ok: false })
        log('warn', 'panel spool file rejected', { file: full, code: result && result.code, error: result && result.error })
      }
    }

    for (const producer of [...seen.keys()]) {
      if (onDisk.has(producer)) continue
      seen.delete(producer)
      const removed = clear(producer)
      if (removed > 0) changed += removed
    }

    return { changed, producers: seen.size }
  }

  return {
    dir,
    poll,
    stats() {
      return { dir, producers: seen.size, published, lastError }
    },
  }
}
