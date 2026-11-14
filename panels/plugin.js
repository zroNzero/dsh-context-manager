// Panel host plugin — a second row in the bundle, deliberately separate from the
// whale widget itself.
//
// Why a second plugin row instead of code inside the whale:
//   - the whale (`lib/whale.js`) is the upstream package, kept byte-for-byte so
//     it can be upgraded by dropping in a new tarball; nothing here patches it;
//   - the panel host only needs `webServer`, the context service and the index
//     injection table, so it has no reason to share the whale's lifetime;
//   - turning the whole feature off is then "this row does nothing", not "some
//     branch inside the whale is skipped".
//
// Desktop delivery uses the structured `webserver/index-inject` row (the only
// channel that reaches the Electron shell), registered synchronously before any
// service is awaited — see docs/RESEARCH.md §2.6. The browser form additionally
// gets a `tapIndex` tag; both guards make a double load inert.

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPanelRuntime } from './runtime.js'
import { resolvePanelsFlag } from './flag.js'

export const name = 'dsh-savings-panels'
export const inject = []

export const PANEL_CLIENT_PATH = '/dsh-savings/panel.js'

// panels/ 就挂在包根下一级（原来是 lib/panels/ 两级），所以只需向上一级。
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const INDEX_ROW_TEXT = '(function(){try{if(window.__dshSavingsPanels)return;' +
  'var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'if(document.querySelector&&document.querySelector("script[data-dshw-panels]"))return;' +
  'var s=document.createElement("script");s.src="' + PANEL_CLIENT_PATH + '";' +
  's.onerror=function(){};s.setAttribute("data-dshw-panels","host");d.appendChild(s)}catch(e){}})()'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{panels?: {enabled?: boolean}}} [config]
 */
export function apply(ctx, config) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  // Resolved synchronously so that "off" means literally nothing is injected.
  const flag = resolvePanelsFlag({ config, env: process.env, home, packageRoot: PACKAGE_ROOT })

  // (1) Index row: no services needed, and it must exist before the desktop
  //     shell collects its one-shot injection table.
  if (flag.enabled) {
    try {
      ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === PANEL_CLIENT_PATH) return
            if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(PANEL_CLIENT_PATH) >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: INDEX_ROW_TEXT })
        } catch (err) {}
      }))
    } catch (err) {
      console.warn('[dsh-savings-panels] could not register the desktop index row:', String((err && err.message) || err))
    }
  }

  // (2) Everything that needs the web server (routes, SSE, service, polling).
  ctx.inject(['webServer'], (inner) => {
    let runtime = null
    try {
      runtime = createPanelRuntime(inner, {
        config,
        log: (level, message, detail) => {
          try {
            const logger = typeof inner.logger === 'function' ? inner.logger('dsh-savings-panels') : null
            if (logger && typeof logger[level] === 'function') logger[level](message, detail)
            else if (level === 'warn' || level === 'error') console.warn('[dsh-savings-panels]', message, detail || '')
          } catch (err) {}
        },
      })
      inner.effect(() => () => runtime.dispose())
      try {
        inner.effect(() => inner.provide('savingsPanels', runtime.service))
      } catch (err) {
        console.warn('[dsh-savings-panels] could not provide the savingsPanels service:', String((err && err.message) || err))
      }
      if (runtime.enabled) {
        // Browser form: the same client through the HTML transform path.
        try {
          inner.effect(() => inner.webServer.tapIndex((html) => {
            if (html.indexOf(PANEL_CLIENT_PATH) !== -1) return html
            const tag = '<script defer src="' + PANEL_CLIENT_PATH + '"></script>'
            if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
            return html + tag
          }))
        } catch (err) {}
      }
    } catch (err) {
      console.warn('[dsh-savings-panels] panel host disabled after an error:', String((err && err.message) || err))
    }
  })
}

export { INDEX_ROW_TEXT }
