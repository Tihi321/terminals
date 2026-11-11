// Renders build/icon.svg to build/icon.png (512x512) and build/icon.ico (multi-size, PNG-compressed).
import { Resvg } from '@resvg/resvg-js'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const build = join(dirname(fileURLToPath(import.meta.url)), '..', 'build')
const svg = readFileSync(join(build, 'icon.svg'))
const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

writeFileSync(join(build, 'icon.png'), render(512))

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = sizes.map(render)
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = 6 + 16 * sizes.length
const entries = sizes.map((s, i) => {
  const e = Buffer.alloc(16)
  e[0] = s === 256 ? 0 : s
  e[1] = s === 256 ? 0 : s
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(pngs[i].length, 8)
  e.writeUInt32LE(offset, 12)
  offset += pngs[i].length
  return e
})
writeFileSync(join(build, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]))
console.log('wrote build/icon.png and build/icon.ico')
