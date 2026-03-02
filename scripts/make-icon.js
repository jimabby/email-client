#!/usr/bin/env node
/**
 * Generates Hermes app icons from build/icon.svg
 * Output:
 *   build/icons/512x512.png  — used by electron-builder for Linux + macOS
 *   build/icons/icon.ico     — used by electron-builder for Windows
 */

const { Resvg } = require('@resvg/resvg-js')
const pngToIcoMod = require('png-to-ico')
const pngToIco = pngToIcoMod.default || pngToIcoMod
const fs        = require('fs')
const path      = require('path')

const ROOT      = path.join(__dirname, '..')
const SVG_PATH  = path.join(ROOT, 'build', 'icon.svg')
const ICONS_DIR = path.join(ROOT, 'build', 'icons')

async function main() {
  fs.mkdirSync(ICONS_DIR, { recursive: true })

  const svgData = fs.readFileSync(SVG_PATH, 'utf8')

  // Render at 512×512
  const resvg  = new Resvg(svgData, { fitTo: { mode: 'width', value: 512 } })
  const pixels = resvg.render()
  const png512 = pixels.asPng()

  const png512Path = path.join(ICONS_DIR, '512x512.png')
  fs.writeFileSync(png512Path, png512)
  console.log('✓ build/icons/512x512.png')

  // Render at 256×256 for the ICO (Windows)
  const resvg256  = new Resvg(svgData, { fitTo: { mode: 'width', value: 256 } })
  const pixels256 = resvg256.render()
  const png256    = pixels256.asPng()

  const png256Path = path.join(ICONS_DIR, '256x256.png')
  fs.writeFileSync(png256Path, png256)

  // Build the .ico (Windows) — bundles 16/32/48/256 sizes
  const icoBuffer = await pngToIco([png256Path])
  const icoPath   = path.join(ICONS_DIR, 'icon.ico')
  fs.writeFileSync(icoPath, icoBuffer)
  console.log('✓ build/icons/icon.ico')

  console.log('\nDone! Run "npm run dist" to package the app.')
}

main().catch(err => { console.error(err); process.exit(1) })
