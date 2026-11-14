// Feature flag resolution for the panel UI.
//
// The flag is resolved once, at plugin activation. Three sources, in order of
// precedence, so a user can turn the panels on without editing the profile:
//
//   1. environment variable DSH_SAVINGS_PANELS=1|0
//   2. flag file  $DSH_HOME/.dsh-savings-panels.json  -> {"enabled": true}
//   3. plugin Config                              -> config.panels.enabled
//   4. default: disabled
//
// Rationale: the default-off promise is only credible if "off" is the state
// nobody has to configure. The env var covers throwaway/test hosts, the file
// covers users of the packaged desktop app (which has no profile config UI for
// this plugin), and Config covers profile authors.
//
// Changing the flag takes effect on the next host restart, because the served
// browser script is composed from it (see runtime.clientScript()).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { stripBom } from './schema.js'

const TRUTHY = new Set(['1', 'true', 'on', 'yes', 'enable', 'enabled'])
const FALSY = new Set(['0', 'false', 'off', 'no', 'disable', 'disabled'])

export const FLAG_ENV = 'DSH_SAVINGS_PANELS'
export const FLAG_FILE = '.dsh-savings-panels.json'

function parseBoolean(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  if (TRUTHY.has(normalized)) return true
  if (FALSY.has(normalized)) return false
  return null
}

/**
 * @param {object} [options]
 * @param {object} [options.config] plugin row config
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string} [options.home] DSH home
 * @param {typeof fs.readFileSync} [options.readFile]
 * @param {(level: string, message: string, detail?: object) => void} [options.log]
 * @returns {{enabled: boolean, source: string, detail: string}}
 */
export function resolvePanelsFlag(options = {}) {
  const env = options.env || process.env
  const home = options.home || env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const readFile = options.readFile || ((p) => fs.readFileSync(p, 'utf8'))
  const log = typeof options.log === 'function' ? options.log : () => {}
  const flagPath = path.join(home, FLAG_FILE)

  const fromEnv = parseBoolean(env[FLAG_ENV])
  if (fromEnv !== null) {
    return { enabled: fromEnv, source: 'env', detail: FLAG_ENV + '=' + String(env[FLAG_ENV]) }
  }

  // Two file locations, same format. The user-level file under $DSH_HOME wins
  // over the one that travels with the checkout, because a checkout is shared
  // and a machine-wide preference should not be silently overridden by it.
  const packageRoot = typeof options.packageRoot === 'string' && options.packageRoot.length > 0 ? options.packageRoot : null
  const candidates = [
    { path: flagPath, source: 'file' },
    ...(packageRoot ? [{ path: path.join(packageRoot, FLAG_FILE), source: 'package' }] : []),
  ]

  for (const candidate of candidates) {
    try {
      // PowerShell 5.1 `Set-Content -Encoding UTF8` writes a BOM; the README
      // tells users to write this file exactly that way.
      const parsed = JSON.parse(stripBom(readFile(candidate.path)))
      const fromFile = parseBoolean(parsed && typeof parsed === 'object' ? (parsed.enabled ?? parsed.panels) : parsed)
      if (fromFile !== null) {
        return { enabled: fromFile, source: candidate.source, detail: candidate.path }
      }
      log('warn', 'panel flag file has no usable "enabled" field', { path: candidate.path })
    } catch (err) {
      // ENOENT is the normal case; anything else means the file exists but is
      // unreadable or malformed, which must not break plugin activation.
      const code = err && err.code
      if (code !== 'ENOENT') log('warn', 'panel flag file is unreadable, ignoring it', { path: candidate.path, error: String((err && err.message) || err) })
    }
  }

  const config = options.config && typeof options.config === 'object' ? options.config : {}
  const fromConfig = parseBoolean(config.panels && typeof config.panels === 'object' ? config.panels.enabled : undefined)
  if (fromConfig !== null) {
    return { enabled: fromConfig, source: 'config', detail: 'config.panels.enabled' }
  }

  return { enabled: false, source: 'default', detail: 'disabled unless enabled by env, a flag file, or config' }
}
