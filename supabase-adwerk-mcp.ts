// Adwerk MCP-server: laat een AI-agent (zoals Claude) live ontwerpen maken en bewerken.
// Transport: MCP Streamable HTTP (stateless, JSON-antwoorden). Toegang met een persoonlijke sleutel uit Adwerk.
// Elke actie verschijnt live bij wie het ontwerp open heeft: een cursor die zich als een mens beweegt, daarna de wijziging.
import { createClient } from 'npm:@supabase/supabase-js@2'
import opentype from 'npm:opentype.js@1.3.4'
import { initWasm, Resvg } from 'npm:@resvg/resvg-wasm@2.6.2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APP_URL = 'https://serviceteam-daarom.github.io/adwerk/'
const db = createClient(SB_URL, SRK, { auth: { persistSession: false } })

// ===== SERVER-RENDER (begin) =====
// Rendert een formaat naar PNG zonder browser: SVG opbouwen (tekst als paden via opentype.js) en rasteren met resvg.
// Wordt gebruikt als niemand het ontwerp open heeft; anders levert de editor een pixel-exacte render.

// deno-lint-ignore no-explicit-any
type AnyEl = Record<string, any>
// deno-lint-ignore no-explicit-any
type AnyFrame = { w: number; h: number; duration: number; background: { type: string; color: string; color2: string; angle: number; src?: string }; elements: AnyEl[] }

let wasm: Promise<void> | null = null
const ensureWasm = () => (wasm ??= initWasm(fetch('https://unpkg.com/@resvg/resvg-wasm@2.6.2/index_bg.wasm')))

/* ---------- fonts ---------- */
const fontCache = new Map<string, Promise<opentype.Font | null>>()
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]
async function fetchFont(family: string, weight: number, italic: boolean): Promise<opentype.Font | null> {
  const key = `${family}|${weight}|${italic}`
  if (!fontCache.has(key)) {
    fontCache.set(key, (async () => {
      const slug = family.toLowerCase().trim().replace(/\s+/g, '-')
      const r = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-${weight}-${italic ? 'italic' : 'normal'}.woff`)
      if (!r.ok) return null
      return opentype.parse(await r.arrayBuffer())
    })().catch(() => null))
  }
  return fontCache.get(key)!
}
async function loadFont(family: string, weight: number, italic: boolean): Promise<opentype.Font> {
  const order = [...WEIGHTS].sort((a, b) => Math.abs(a - weight) - Math.abs(b - weight) || b - a)
  for (const fam of [family, 'Poppins']) {
    for (const it of italic ? [true, false] : [false]) {
      for (const w of order.slice(0, 4)) { const f = await fetchFont(fam, w, it); if (f) return f }
    }
  }
  throw new Error('Lettertype niet beschikbaar')
}

/* ---------- beelden ---------- */
const imgCache = new Map<string, Promise<{ uri: string; w: number; h: number; svg: boolean } | null>>()
function dims(bytes: Uint8Array, type: string) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) }
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2
      while (i < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue }
        const m = bytes[i + 1], len = dv.getUint16(i + 2)
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) }
        i += 2 + len
      }
    }
    if (String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
      const c = String.fromCharCode(...bytes.slice(12, 16))
      if (c === 'VP8X') return { w: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), h: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) }
      if (c === 'VP8L') { const b = dv.getUint32(21, true); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 } }
      if (c === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff }
    }
    if (type.includes('svg')) {
      const t = new TextDecoder().decode(bytes.slice(0, 4000))
      const vb = t.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)
      if (vb) return { w: +vb[1], h: +vb[2] }
    }
  } catch { /* onbekend */ }
  return { w: 1000, h: 1000 }
}
const b64 = (bytes: Uint8Array) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s) }
function loadImg(src: string) {
  if (!imgCache.has(src)) {
    imgCache.set(src, (async () => {
      let bytes: Uint8Array, type: string
      if (src.startsWith('data:')) {
        const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
        if (!m) return null
        type = m[1]
        bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]))
      } else {
        const r = await fetch(src)
        if (!r.ok) return null
        type = (r.headers.get('content-type') || '').split(';')[0] || (src.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
        bytes = new Uint8Array(await r.arrayBuffer())
      }
      if (/\.svg(\?|$)/i.test(src)) type = 'image/svg+xml'
      const d = dims(bytes, type)
      return { uri: `data:${type};base64,${b64(bytes)}`, w: d.w, h: d.h, svg: type.includes('svg') }
    })().catch(() => null))
  }
  return imgCache.get(src)!
}

async function iconifySvg(name: string): Promise<string | null> {
  try {
    const r = await fetch(`https://api.iconify.design/lucide/${name}.svg?height=256`)
    return r.ok ? await r.text() : null
  } catch { return null }
}

/* ---------- animatie (zelfde als de editor) ---------- */
interface St { dx: number; dy: number; scale: number; rotation: number; opacity: number }
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const eoc = (t: number) => 1 - Math.pow(1 - t, 3)
const eob = (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2) }
function inState(type: string, p: number, dist: number): St {
  const e = eoc(p), s: St = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 }
  switch (type) {
    case 'fade': s.opacity = e; break
    case 'slideUp': s.dy = (1 - e) * dist; s.opacity = e; break
    case 'slideDown': s.dy = -(1 - e) * dist; s.opacity = e; break
    case 'slideLeft': s.dx = (1 - e) * dist; s.opacity = e; break
    case 'slideRight': s.dx = -(1 - e) * dist; s.opacity = e; break
    case 'zoomIn': s.scale = 0.6 + 0.4 * e; s.opacity = e; break
    case 'zoomOut': s.scale = 1.4 - 0.4 * e; s.opacity = e; break
    case 'pop': s.scale = Math.max(0, eob(p)); s.opacity = clamp01(p * 3); break
    case 'spin': s.rotation = -120 * (1 - e); s.scale = 0.3 + 0.7 * e; s.opacity = e; break
  }
  return s
}
function emph(type: string, t: number, speed: number): St {
  const s: St = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 }, ph = (t * speed * Math.PI * 2) / 1.6
  if (type === 'pulse') s.scale = 1 + 0.06 * (0.5 - 0.5 * Math.cos(ph))
  if (type === 'wiggle') s.rotation = 4 * Math.sin(ph * 2)
  if (type === 'float') s.dy = -8 * (0.5 - 0.5 * Math.cos(ph))
  if (type === 'blink') s.opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(ph))
  return s
}
function stateAt(el: AnyEl, f: AnyFrame, t: number): St {
  const a = el.anim, st: St = { dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1 }
  if (!a) return st
  const dist = Math.round(Math.min(f.w, f.h) * 0.18), parts: St[] = []
  let inEnd = 0
  if (a.in?.type !== 'none') { parts.push(inState(a.in.type, clamp01((t - a.in.delay) / Math.max(0.01, a.in.duration)), dist)); inEnd = a.in.delay + a.in.duration }
  if (a.emph?.type !== 'none' && t > inEnd) parts.push(emph(a.emph.type, t - inEnd, a.emph.speed || 1))
  if (a.out?.type !== 'none') { const start = f.duration - a.out.duration - a.out.delay, q = clamp01((t - start) / Math.max(0.01, a.out.duration)); if (q > 0) parts.push(inState(a.out.type, 1 - q, dist)) }
  for (const p of parts) { st.dx += p.dx; st.dy += p.dy; st.scale *= p.scale; st.rotation += p.rotation; st.opacity *= p.opacity }
  return st
}

/* ---------- tekst ---------- */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
function advance(font: opentype.Font, s: string, fs: number, ls: number) {
  const glyphs = font.stringToGlyphs(s), k = fs / font.unitsPerEm
  let w = 0
  glyphs.forEach((g: opentype.Glyph, i: number) => { w += (g.advanceWidth || 0) * k + ls; if (i < glyphs.length - 1) w += font.getKerningValue(g, glyphs[i + 1]) * k })
  return w
}
function pathFor(font: opentype.Font, s: string, x: number, y: number, fs: number, ls: number) {
  const glyphs = font.stringToGlyphs(s), k = fs / font.unitsPerEm
  let d = '', cx = x
  glyphs.forEach((g: opentype.Glyph, i: number) => { d += g.getPath(cx, y, fs).toPathData(2); cx += (g.advanceWidth || 0) * k + ls; if (i < glyphs.length - 1) cx += font.getKerningValue(g, glyphs[i + 1]) * k })
  return d
}
/** Zelfde opmaak als het canvas: woordafbreking, regelafstand, uitlijning, en kleiner als één woord niet past. */
async function layoutText(el: AnyEl) {
  const font = await loadFont(el.fontFamily || 'Poppins', el.fontWeight || 400, !!el.italic)
  const text = String(el.uppercase ? (el.text || '').toUpperCase() : el.text || '')
  const ls = el.letterSpacing || 0, w = el.width
  let fs = el.fontSize || 24
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length) { const widest = Math.max(...words.map((x) => advance(font, x, fs, ls))); if (widest > w && w > 0) fs = Math.max(4, fs * (w / widest) * 0.98) }
  const lines: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word
      if (line && advance(font, test, fs, ls) > w) { lines.push(line); line = word } else line = test
    }
    lines.push(line)
  }
  const lh = fs * (el.lineHeight || 1.2)
  const mid = ((font.ascender + font.descender) / 2) * (fs / font.unitsPerEm)
  let d = '', under = ''
  lines.forEach((ln, i) => {
    const lw = advance(font, ln, fs, ls) - (ln ? ls : 0)
    const x = el.align === 'center' ? (w - lw) / 2 : el.align === 'right' ? w - lw : 0
    const base = lh * i + lh / 2 + mid
    d += pathFor(font, ln, x, base, fs, ls)
    if (el.underline && ln) under += `<rect x="${x.toFixed(1)}" y="${(base + fs * 0.12).toFixed(1)}" width="${lw.toFixed(1)}" height="${(fs * 0.06).toFixed(1)}"/>`
  })
  return { d, under, height: Math.ceil(lines.length * lh), fontSize: fs, lines }
}

/* ---------- formaat naar SVG ---------- */
function star(w: number, h: number, n: number, ratio: number) {
  const p: string[] = []
  for (let i = 0; i < n * 2; i++) { const r = i % 2 === 0 ? 1 : ratio, a = (Math.PI * i) / n - Math.PI / 2; p.push(`${(w / 2 + Math.cos(a) * (w / 2) * r).toFixed(2)},${(h / 2 + Math.sin(a) * (h / 2) * r).toFixed(2)}`) }
  return p.join(' ')
}
function cover(iw: number, ih: number, w: number, h: number, zoom = 1, fx = 0.5, fy = 0.5) {
  const s = Math.max(w / iw, h / ih) * Math.max(1, zoom), cw = w / s, ch = h / s
  return { x: (iw - cw) * clamp01(fx), y: (ih - ch) * clamp01(fy), w: cw, h: ch }
}

async function frameSvg(f: AnyFrame, t: number | null = null) {
  let defs = '', body = '', uid = 0
  const id = () => `x${uid++}`
  const b = f.background
  if (b.type === 'gradient') {
    const a = ((b.angle || 0) * Math.PI) / 180, cx = f.w / 2, cy = f.h / 2, r = Math.abs((f.w / 2) * Math.cos(a)) + Math.abs((f.h / 2) * Math.sin(a))
    defs += `<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="${cx - Math.cos(a) * r}" y1="${cy - Math.sin(a) * r}" x2="${cx + Math.cos(a) * r}" y2="${cy + Math.sin(a) * r}"><stop offset="0" stop-color="${b.color}"/><stop offset="1" stop-color="${b.color2}"/></linearGradient>`
    body += `<rect width="${f.w}" height="${f.h}" fill="url(#bg)"/>`
  } else body += `<rect width="${f.w}" height="${f.h}" fill="${b.color || '#FFFFFF'}"/>`
  if (b.type === 'image' && b.src) {
    const im = await loadImg(b.src)
    if (im) { const c = cover(im.w, im.h, f.w, f.h); body += `<svg width="${f.w}" height="${f.h}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" preserveAspectRatio="none"><image width="${im.w}" height="${im.h}" href="${im.uri}"/></svg>` }
  }

  for (const el of f.elements) {
    if (el.visible === false) continue
    const w = el.width, st = t === null ? null : stateAt(el, f, t)
    let inner = '', h = el.height
    const fill = el.fill || '#000', stroke = el.strokeWidth > 0 ? ` stroke="${el.stroke}" stroke-width="${el.strokeWidth}"` : ''
    switch (el.type) {
      case 'text': {
        const L = await layoutText(el)
        h = L.height
        inner = `<path d="${L.d}" fill="${fill}"${stroke}/>${L.under ? `<g fill="${fill}">${L.under}</g>` : ''}`
        break
      }
      case 'ellipse': inner = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"${stroke}/>`; break
      case 'triangle': inner = `<polygon points="${w / 2},0 ${w},${h} 0,${h}" fill="${fill}"${stroke} stroke-linejoin="round"/>`; break
      case 'star': inner = `<polygon points="${star(w, h, el.points || 5, el.innerRatio || 0.45)}" fill="${fill}"${stroke} stroke-linejoin="round"/>`; break
      case 'image': {
        const m = el.mask || 'none', cid = id()
        const rr = Math.min(el.cornerRadius || 0, w / 2, h / 2)
        let clip = `<rect width="${w}" height="${h}" rx="${rr}"/>`
        if (m === 'circle') clip = `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}"/>`
        if (m === 'oval') clip = `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}"/>`
        if (m === 'arch') { const r = Math.min(w / 2, h); clip = `<path d="M0 ${h} L0 ${r} A${w / 2} ${r} 0 0 1 ${w} ${r} L${w} ${h} Z"/>` }
        if (m === 'leaf') { const r = Math.min(w, h) * 0.45; clip = `<path d="M${r} 0 H${w} V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} H0 V${r} A${r} ${r} 0 0 1 ${r} 0 Z"/>` }
        if (m === 'blob') clip = `<ellipse cx="${w * 0.66}" cy="${h * 0.66}" rx="${w * 0.8}" ry="${h * 0.8}"/>`
        defs += `<clipPath id="${cid}">${clip}</clipPath>`
        const im = el.src ? await loadImg(el.src) : null
        if (im) {
          const c = cover(im.w, im.h, w, h, el.cropZoom, el.cropX ?? 0.5, el.cropY ?? 0.5)
          const flip = el.flipX || el.flipY ? ` transform="translate(${el.flipX ? w : 0} ${el.flipY ? h : 0}) scale(${el.flipX ? -1 : 1} ${el.flipY ? -1 : 1})"` : ''
          inner = `<g clip-path="url(#${cid})"><g${flip}><svg width="${w}" height="${h}" viewBox="${c.x} ${c.y} ${c.w} ${c.h}" preserveAspectRatio="none"><image width="${im.w}" height="${im.h}" href="${im.uri}"/></svg></g></g>`
        } else {
          const s = Math.max(16, Math.min(w, h) * 0.16)
          inner = `<g clip-path="url(#${cid})"><rect width="${w}" height="${h}" fill="${el.fill || '#D9D6E3'}"/></g><g transform="translate(${w / 2 - s / 2} ${h / 2 - s / 2}) scale(${s / 24})" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round"><path d="M21 15l-5-5L5 21 M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="9" cy="9" r="2"/></g>`
        }
        break
      }
      case 'icon': {
        let svg: string | null = el.iconSvg || null
        if (!svg && el.icon) svg = await iconifySvg(el.icon)
        if (svg) {
          if (!el.iconMulti) svg = svg.replace(/currentColor/g, fill)
          inner = `<image width="${w}" height="${h}" href="data:image/svg+xml;base64,${b64(new TextEncoder().encode(svg))}"/>`
        }
        break
      }
      default: inner = `<rect width="${w}" height="${h}" rx="${Math.min(el.cornerRadius || 0, w / 2, h / 2)}" fill="${fill}"${stroke}/>`
    }
    const cx = el.x + w / 2 + (st?.dx || 0), cy = el.y + h / 2 + (st?.dy || 0)
    const rot = (el.rotation || 0) + (st?.rotation || 0), sc = st?.scale ?? 1, op = (el.opacity ?? 1) * (st?.opacity ?? 1)
    let filter = ''
    if (el.shadow?.enabled) {
      const fid = id(), s = el.shadow
      defs += `<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx="${s.x}" dy="${s.y}" stdDeviation="${s.blur / 2}" flood-color="${s.color}" flood-opacity="${s.opacity}"/></filter>`
      filter = ` filter="url(#${fid})"`
    }
    if (op <= 0.001) continue
    body += `<g transform="translate(${cx.toFixed(2)} ${cy.toFixed(2)}) rotate(${rot}) scale(${sc}) translate(${(-w / 2).toFixed(2)} ${(-h / 2).toFixed(2)})" opacity="${op}"${filter}>${inner}</g>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${f.w}" height="${f.h}" viewBox="0 0 ${f.w} ${f.h}"><defs><clipPath id="frame"><rect width="${f.w}" height="${f.h}"/></clipPath>${defs}</defs><g clip-path="url(#frame)">${body}</g></svg>`
}

async function renderFramePng(f: AnyFrame, t: number | null, maxSide: number): Promise<Uint8Array> {
  await ensureWasm()
  const svg = await frameSvg(f, t)
  const scale = Math.min(2, maxSide / Math.max(f.w, f.h))
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: scale }, font: { loadSystemFonts: false }, imageRendering: 0 })
  const png = r.render().asPng()
  r.free()
  return png
}
void esc
/** Toont een volledige (niet uitgesneden) foto met een raster van 10%, zodat de agent het focuspunt kan bepalen. */
async function renderImageGrid(src: string, maxSide: number): Promise<{ png: Uint8Array; w: number; h: number }> {
  await ensureWasm()
  const im = await loadImg(src)
  if (!im) throw new Error('Afbeelding kon niet worden geladen')
  const W = im.w, H = im.h, sw = Math.max(1, Math.min(W, H) / 400), fs = Math.max(10, Math.min(W, H) / 32)
  let grid = ''
  for (let i = 1; i < 10; i++) {
    const x = (W * i) / 10, y = (H * i) / 10, strong = i === 5
    grid += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="${strong ? '#FF2E88' : '#FFFFFF'}" stroke-opacity="${strong ? 0.9 : 0.55}" stroke-width="${sw}"/><line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="${strong ? '#FF2E88' : '#FFFFFF'}" stroke-opacity="${strong ? 0.9 : 0.55}" stroke-width="${sw}"/>`
  }
  const font = await loadFont('Poppins', 600, false)
  let labels = ''
  for (let i = 1; i < 10; i++) {
    const v = (i / 10).toFixed(1)
    labels += `<path d="${pathFor(font, v, (W * i) / 10 + fs * 0.2, fs * 1.1, fs, 0)}"/><path d="${pathFor(font, v, fs * 0.3, (H * i) / 10 - fs * 0.25, fs, 0)}"/>`
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><image width="${W}" height="${H}" href="${im.uri}"/>${grid}<g fill="#FFFFFF" stroke="#000" stroke-opacity=".6" stroke-width="${sw * 2}" paint-order="stroke">${labels}</g></svg>`
  const r = new Resvg(svg, { fitTo: { mode: 'zoom', value: Math.min(1, maxSide / Math.max(W, H)) }, font: { loadSystemFonts: false } })
  const png = r.render().asPng()
  r.free()
  return { png, w: W, h: H }
}
async function imageDims(src: string) { const im = await loadImg(src); return im ? { w: im.w, h: im.h } : null }

// ===== SERVER-RENDER (einde) =====


const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version, accept',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, DELETE',
  'Access-Control-Expose-Headers': 'mcp-session-id',
}

/* ------------------------------------------------------------------ types en helpers */
type Json = Record<string, unknown>
interface El { id: string; type: string; name: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; visible: boolean; locked: boolean; fill: string; stroke: string; strokeWidth: number; cornerRadius: number; shadow: Json; blend: string; anim?: { in: { type: string; delay: number; duration: number }; out: { type: string; delay: number; duration: number }; emph: { type: string; speed: number } }; [k: string]: unknown }
interface Frame { id: string; name: string; w: number; h: number; platform: string; background: { type: string; color: string; color2: string; angle: number; src?: string }; elements: El[]; duration: number; safeZone?: boolean }
interface Doc { version: 1; frames: Frame[]; colors?: string[] }
interface Ctx { userId: string; agentName: string; agentKey: string }

const uid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 10)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))
const r1 = (n: number) => Math.round(n * 10) / 10

const FORMATS: { key: string; name: string; w: number; h: number; platform: string }[] = [
  { key: 'meta-sq', name: 'Feed vierkant', w: 1080, h: 1080, platform: 'Meta' },
  { key: 'meta-45', name: 'Feed staand 4:5', w: 1080, h: 1350, platform: 'Meta' },
  { key: 'meta-story', name: 'Story en Reels', w: 1080, h: 1920, platform: 'Meta' },
  { key: 'meta-land', name: 'Liggend 1.91:1', w: 1200, h: 628, platform: 'Meta' },
  { key: 'li-land', name: 'LinkedIn liggend', w: 1200, h: 627, platform: 'LinkedIn' },
  { key: 'li-sq', name: 'LinkedIn vierkant', w: 1200, h: 1200, platform: 'LinkedIn' },
  { key: 'li-vert', name: 'LinkedIn staand', w: 720, h: 900, platform: 'LinkedIn' },
  { key: 'g-300x250', name: 'Medium rectangle', w: 300, h: 250, platform: 'Google Display' },
  { key: 'g-336x280', name: 'Large rectangle', w: 336, h: 280, platform: 'Google Display' },
  { key: 'g-728x90', name: 'Leaderboard', w: 728, h: 90, platform: 'Google Display' },
  { key: 'g-300x600', name: 'Half page', w: 300, h: 600, platform: 'Google Display' },
  { key: 'g-160x600', name: 'Wide skyscraper', w: 160, h: 600, platform: 'Google Display' },
  { key: 'g-320x50', name: 'Mobile banner', w: 320, h: 50, platform: 'Google Display' },
  { key: 'g-320x100', name: 'Large mobile banner', w: 320, h: 100, platform: 'Google Display' },
  { key: 'g-970x250', name: 'Billboard', w: 970, h: 250, platform: 'Google Display' },
  { key: 'g-468x60', name: 'Banner', w: 468, h: 60, platform: 'Google Display' },
  { key: 'g-250x250', name: 'Square', w: 250, h: 250, platform: 'Google Display' },
  { key: 'dg-land', name: 'Demand Gen liggend', w: 1200, h: 628, platform: 'Google Ads' },
  { key: 'dg-sq', name: 'Demand Gen vierkant', w: 1200, h: 1200, platform: 'Google Ads' },
  { key: 'dg-port', name: 'Demand Gen staand 4:5', w: 960, h: 1200, platform: 'Google Ads' },
  { key: 'tt-vert', name: 'TikTok', w: 1080, h: 1920, platform: 'TikTok' },
  { key: 'pin', name: 'Pinterest pin', w: 1000, h: 1500, platform: 'Pinterest' },
  { key: 'yt-thumb', name: 'YouTube thumbnail', w: 1280, h: 720, platform: 'YouTube' },
]
const SETS: Record<string, string[]> = {
  social: ['meta-sq', 'meta-45', 'meta-story'],
  google: ['g-300x250', 'g-336x280', 'g-728x90', 'g-300x600', 'g-160x600', 'g-320x50', 'g-970x250'],
  linkedin: ['li-land', 'li-sq', 'li-vert'],
  demandgen: ['dg-land', 'dg-sq', 'dg-port'],
}
const IN_ANIMS = ['none', 'fade', 'slideUp', 'slideDown', 'slideLeft', 'slideRight', 'zoomIn', 'zoomOut', 'pop', 'spin']
const EMPH_ANIMS = ['none', 'pulse', 'wiggle', 'float', 'blink']
const FONTS = ['Poppins', 'Caveat', 'Inter', 'Montserrat', 'Roboto', 'Open Sans', 'Lato', 'Raleway', 'Playfair Display', 'DM Serif Display', 'Anton', 'Bebas Neue', 'Oswald', 'Archivo Black', 'Unbounded', 'Space Grotesk', 'Nunito', 'Rubik', 'Work Sans', 'Merriweather']

function makeFrame(f: { name: string; w: number; h: number; platform: string }): Frame {
  return { id: uid(), name: `${f.name} ${f.w}×${f.h}`, w: f.w, h: f.h, platform: f.platform, background: { type: 'solid', color: '#FFFFFF', color2: '#F6F5FA', angle: 135 }, elements: [], duration: 6, safeZone: f.h / f.w > 1.7 }
}

function baseEl(type: string, name: string, patch: Partial<El>): El {
  return {
    id: uid(), type, name, x: 0, y: 0, width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false,
    fill: '#EA5F39', stroke: '#1B213B', strokeWidth: 0, cornerRadius: 0,
    shadow: { enabled: false, color: '#000000', blur: 20, x: 0, y: 8, opacity: 0.25 }, blend: 'source-over',
    anim: { in: { type: 'none', delay: 0, duration: 0.6 }, out: { type: 'none', delay: 0, duration: 0.5 }, emph: { type: 'none', speed: 1 } },
    ...patch,
  } as El
}

/** Tekstblok: hoogte schatten (het canvas meet het daarna exact). */
function textHeight(text: string, width: number, fontSize: number, lineHeight: number) {
  const cpl = Math.max(1, Math.floor(width / (fontSize * 0.56)))
  const lines = text.split('\n').reduce((n, p) => n + Math.max(1, Math.ceil(p.length / cpl)), 0)
  return Math.round(lines * fontSize * lineHeight)
}

/* ------------------------------------------------------------------ patches (zelfde formaat als de app) */
interface FramePatch { id: string; meta?: Json; full?: Frame; upserts?: El[]; deletes?: string[]; order?: string[] }
interface DocPatch { frameOrder?: string[]; removed?: string[]; frames: FramePatch[] }
const META = ['name', 'w', 'h', 'platform', 'background', 'duration', 'safeZone'] as const
function diffDocs(a: Doc, b: Doc): DocPatch | null {
  const patch: DocPatch = { frames: [] }
  const aMap = new Map(a.frames.map((f) => [f.id, f]))
  const bIds = b.frames.map((f) => f.id)
  if (bIds.join() !== a.frames.map((f) => f.id).join()) patch.frameOrder = bIds
  const removed = a.frames.filter((f) => !bIds.includes(f.id)).map((f) => f.id)
  if (removed.length) patch.removed = removed
  for (const f of b.frames) {
    const pf = aMap.get(f.id)
    if (!pf) { patch.frames.push({ id: f.id, full: f }); continue }
    const fp: FramePatch = { id: f.id }
    const meta: Json = {}
    for (const k of META) if (JSON.stringify(pf[k]) !== JSON.stringify(f[k])) meta[k] = f[k]
    if (Object.keys(meta).length) fp.meta = meta
    const pe = new Map(pf.elements.map((e) => [e.id, JSON.stringify(e)]))
    const ups = f.elements.filter((e) => pe.get(e.id) !== JSON.stringify(e))
    if (ups.length) fp.upserts = ups
    const ids = f.elements.map((e) => e.id)
    const dels = pf.elements.filter((e) => !ids.includes(e.id)).map((e) => e.id)
    if (dels.length) fp.deletes = dels
    const hasNew = ids.some((i) => !pe.has(i))
    const same = ids.filter((i) => pe.has(i)).join() === pf.elements.map((e) => e.id).filter((i) => ids.includes(i)).join()
    if (hasNew || !same) fp.order = ids
    if (fp.meta || fp.upserts || fp.deletes || fp.order) patch.frames.push(fp)
  }
  return patch.frames.length || patch.frameOrder || patch.removed ? patch : null
}

/* ------------------------------------------------------------------ realtime: live bij collega's */
async function broadcast(designId: string, messages: { event: string; payload: unknown }[]) {
  try {
    await fetch(`${SB_URL}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SRK, Authorization: `Bearer ${SRK}` },
      body: JSON.stringify({ messages: messages.map((m) => ({ topic: `design:${designId}`, event: m.event, payload: m.payload, private: false })) }),
    })
  } catch { /* live is een extraatje; opslaan gaat altijd door */ }
}

class Live {
  constructor(private designId: string, private ctx: Ctx, private frameId: string) {}
  pos = { x: 0, y: 0 }
  setFrame(id: string) { this.frameId = id }
  agent(extra: Json) {
    return { event: 'agent', payload: { key: this.ctx.agentKey, id: this.ctx.agentKey, name: this.ctx.agentName, color: '#6D28D9', frameId: this.frameId, ...extra } }
  }
  /** Beweeg de cursor als een mens: reistijd hangt af van de afstand. */
  async moveTo(x: number, y: number, action = 'move', selection?: string[]) {
    const dist = Math.hypot(x - this.pos.x, y - this.pos.y)
    this.pos = { x, y }
    await broadcast(this.designId, [this.agent({ cursor: { x: r1(x), y: r1(y) }, action, ...(selection ? { selection } : {}) })])
    await sleep(Math.min(1100, 280 + Math.sqrt(dist) * 22) + 60)
  }
  async click(selection?: string[]) {
    await broadcast(this.designId, [this.agent({ cursor: this.pos, action: 'click', ...(selection ? { selection } : {}) })])
    await sleep(170)
  }
  async send(msgs: { event: string; payload: unknown }[]) { await broadcast(this.designId, msgs) }
  async status(action: string, selection?: string[]) { await broadcast(this.designId, [this.agent({ cursor: this.pos, action, ...(selection ? { selection } : {}) })]) }
}

/* ------------------------------------------------------------------ toegang en opslag */
async function loadDesign(id: string, ctx: Ctx) {
  const { data: d } = await db.from('designs').select('*').eq('id', id).maybeSingle()
  if (!d) throw new Error('Ontwerp niet gevonden')
  if (d.owner_id !== ctx.userId && d.visibility !== 'team') {
    const { data: m } = await db.from('design_members').select('user_id').eq('design_id', id).eq('user_id', ctx.userId).maybeSingle()
    if (!m) throw new Error('Je hebt geen toegang tot dit ontwerp')
  }
  return d as { id: string; title: string; data: Doc; updated_at: string; owner_id: string; visibility: string }
}

/** Wijzigt een ontwerp: lezen, aanpassen, opslaan (met controle op gelijktijdige wijzigingen), live doorsturen. */
async function editDesign(id: string, ctx: Ctx, fn: (doc: Doc) => Promise<void> | void, opts: { live?: Live; broadcastPatch?: boolean } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await loadDesign(id, ctx)
    const before = row.data
    const after = clone(before)
    await fn(after)
    const patch = diffDocs(before, after)
    if (!patch) return { doc: after, patch: null }
    const now = new Date().toISOString()
    const { data: upd } = await db.from('designs').update({ data: after, updated_at: now, updated_by: ctx.userId }).eq('id', id).eq('updated_at', row.updated_at).select('id')
    if (upd && upd.length) {
      if (opts.broadcastPatch !== false) await broadcast(id, [{ event: 'patch', payload: patch }])
      return { doc: after, patch }
    }
    await sleep(150 + attempt * 150)
  }
  throw new Error('Het ontwerp werd tegelijk door iemand anders gewijzigd. Probeer het opnieuw.')
}

function pickFrames(doc: Doc, frameId?: string): Frame[] {
  if (!doc.frames.length) throw new Error('Dit ontwerp heeft nog geen formaten')
  if (!frameId) return [doc.frames[0]]
  if (frameId === 'all') return doc.frames
  const f = doc.frames.find((x) => x.id === frameId || x.name === frameId)
  if (!f) throw new Error(`Formaat ${frameId} bestaat niet. Gebruik get_design om de formaat-id's te zien.`)
  return [f]
}

/** Waarden gelden voor het eerste (referentie)formaat en schalen mee naar de andere formaten. */
function mapBox(ref: Frame, f: Frame, b: { x: number; y: number; width: number; height: number }) {
  if (ref.id === f.id) return { ...b, k: 1 }
  const k = Math.min(f.w / ref.w, f.h / ref.h)
  const w = b.width * k, h = b.height * k
  const cx = ((b.x + b.width / 2) / ref.w) * f.w, cy = ((b.y + b.height / 2) / ref.h) * f.h
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), width: Math.round(w), height: Math.round(h), k }
}

function findEl(doc: Doc, elId: string): { frame: Frame; el: El; index: number } {
  for (const frame of doc.frames) { const index = frame.elements.findIndex((e) => e.id === elId); if (index >= 0) return { frame, el: frame.elements[index], index } }
  throw new Error(`Element ${elId} bestaat niet. Gebruik get_design voor de element-id's.`)
}

/* ------------------------------------------------------------------ beelden en iconen */
function imageSize(bytes: Uint8Array, type: string): { w: number; h: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return { w: dv.getUint32(16), h: dv.getUint32(20) }
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2
      while (i < bytes.length) {
        if (bytes[i] !== 0xff) { i++; continue }
        const m = bytes[i + 1], len = dv.getUint16(i + 2)
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) }
        i += 2 + len
      }
    }
    if (String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') {
      const chunk = String.fromCharCode(...bytes.slice(12, 16))
      if (chunk === 'VP8X') return { w: 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)), h: 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) }
      if (chunk === 'VP8L') { const b = dv.getUint32(21, true); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 } }
      if (chunk === 'VP8 ') return { w: dv.getUint16(26, true) & 0x3fff, h: dv.getUint16(28, true) & 0x3fff }
    }
    if (type.includes('svg')) {
      const t = new TextDecoder().decode(bytes.slice(0, 4000))
      const vb = t.match(/viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)
      if (vb) return { w: +vb[1], h: +vb[2] }
      const w = t.match(/\swidth="([\d.]+)/), h = t.match(/\sheight="([\d.]+)/)
      if (w && h) return { w: +w[1], h: +h[1] }
    }
  } catch { /* onbekend */ }
  return { w: 1000, h: 1000 }
}

function safeUrl(u: string) {
  const url = new URL(u)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Alleen http(s)-adressen')
  if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/.test(url.hostname)) throw new Error('Dit adres is niet toegestaan')
  return url.toString()
}

async function importImage(src: string, ctx: Ctx, name?: string, shared = false) {
  let bytes: Uint8Array, type: string
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
    if (!m) throw new Error('Ongeldige data-URL')
    type = m[1]
    bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]))
  } else {
    const r = await fetch(safeUrl(src), { headers: { 'User-Agent': 'Mozilla/5.0 Adwerk' }, redirect: 'follow' })
    if (!r.ok) throw new Error(`Beeld ophalen mislukt (${r.status})`)
    type = (r.headers.get('content-type') || 'image/png').split(';')[0]
    bytes = new Uint8Array(await r.arrayBuffer())
  }
  if (!type.startsWith('image/')) throw new Error('Dit is geen afbeelding')
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('Afbeelding is groter dan 20 MB')
  const ext = (type.split('/')[1] || 'png').replace('svg+xml', 'svg').replace('jpeg', 'jpg')
  const path = `${ctx.userId}/${crypto.randomUUID()}.${ext}`
  const { error } = await db.storage.from('assets').upload(path, bytes, { contentType: type, cacheControl: '31536000' })
  if (error) throw new Error('Opslaan van de afbeelding mislukt')
  const url = db.storage.from('assets').getPublicUrl(path).data.publicUrl
  const size = imageSize(bytes, type)
  const fileName = name || (src.startsWith('data:') ? `agent-beeld.${ext}` : decodeURIComponent(new URL(src).pathname.split('/').pop() || `beeld.${ext}`)).slice(0, 120)
  await db.from('assets').insert({ url, path, name: fileName, width: size.w, height: size.h, shared, owner_id: ctx.userId })
  return { url, ...size }
}

async function iconSvg(id: string): Promise<{ svg: string; multi: boolean }> {
  const [prefix, name] = id.split(':')
  if (!prefix || !name) throw new Error('Gebruik een Iconify-id zoals "ph:shopping-cart" (zoek met search_icons)')
  const r = await fetch(`https://api.iconify.design/${prefix}.json?icons=${encodeURIComponent(name)}`)
  if (!r.ok) throw new Error('Icoon ophalen mislukt')
  const j = await r.json() as { width?: number; height?: number; icons: Record<string, { body: string; width?: number; height?: number; left?: number; top?: number }>; aliases?: Record<string, { parent: string }> }
  const icon = j.icons?.[name] || (j.aliases?.[name] && j.icons[j.aliases[name].parent])
  if (!icon) throw new Error(`Icoon ${id} niet gevonden`)
  const w = icon.width ?? j.width ?? 16, h = icon.height ?? j.height ?? 16
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="${Math.round(256 * h / w)}" viewBox="${icon.left ?? 0} ${icon.top ?? 0} ${w} ${h}">${icon.body}</svg>`
  return { svg, multi: !svg.includes('currentColor') }
}

/* ------------------------------------------------------------------ uitvoer naar de agent */
function summarize(doc: Doc) {
  return doc.frames.map((f) => ({
    frame_id: f.id, name: f.name, width: f.w, height: f.h, platform: f.platform, duration_s: f.duration, background: f.background,
    elements: f.elements.map((e, i) => {
      const o: Json = { id: e.id, type: e.type, name: e.name, layer: i, x: r1(e.x), y: r1(e.y), width: r1(e.width), height: r1(e.height) }
      if (e.rotation) o.rotation = e.rotation
      if (e.opacity !== 1) o.opacity = e.opacity
      if (!e.visible) o.visible = false
      if (e.locked) o.locked = true
      if (e.type === 'text') Object.assign(o, { text: e.text, fontFamily: e.fontFamily, fontSize: e.fontSize, fontWeight: e.fontWeight, color: e.fill, align: e.align })
      else if (e.type === 'image') Object.assign(o, { src: e.src, mask: e.mask || 'none' })
      else if (e.type === 'icon') Object.assign(o, { icon: e.iconId || e.icon, color: e.fill })
      else Object.assign(o, { color: e.fill, cornerRadius: e.cornerRadius })
      const a = e.anim
      if (a && (a.in.type !== 'none' || a.out.type !== 'none' || a.emph.type !== 'none')) o.animation = a
      return o
    }),
  }))
}
const ok = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const designUrl = (id: string) => `${APP_URL}#/d/${id}`

/* ------------------------------------------------------------------ slim meeschalen (zelfde als de editor) */
function smartResize(src: Frame, target: { w: number; h: number }): El[] {
  const sx = target.w / src.w, sy = target.h / src.h, s = Math.min(sx, sy), sMax = Math.max(sx, sy)
  const textK = () => Math.min(Math.max(s, Math.sqrt(sx * sy) * 0.85), sMax)
  const story = target.h / target.w > 1.7 && !(src.h / src.w > 1.7)
  const mapY = (cy: number) => (story ? target.h * 0.14 + (cy / src.h) * target.h * 0.66 : cy * sy)
  const pairK = new Map<string, { k: number; cx: number; cy: number }>()
  for (const e of src.elements) {
    if (e.type === 'text' || e.width * e.height > src.w * src.h * 0.3) continue
    const t = src.elements.find((t) => t.type === 'text' && t.x + t.width / 2 > e.x && t.x + t.width / 2 < e.x + e.width && t.y + t.height / 2 > e.y && t.y + t.height / 2 < e.y + e.height && t.width <= e.width * 1.2)
    if (t) pairK.set(e.id, { k: textK(), cx: t.x + t.width / 2, cy: t.y + t.height / 2 })
  }
  return src.elements.map((e) => {
    const n: El = clone(e)
    n.id = uid()
    if (e.width >= src.w * 0.9 && e.height >= src.h * 0.9) {
      const k = e.type === 'image' ? sMax : 1
      n.width = e.type === 'image' ? e.width * k : e.width * sx
      n.height = e.type === 'image' ? e.height * k : e.height * sy
      n.x = (target.w - n.width) / 2; n.y = (target.h - n.height) / 2
      return n
    }
    const pair = pairK.get(e.id), ocx = e.x + e.width / 2, ocy = e.y + e.height / 2
    const cx = pair ? pair.cx * sx + (ocx - pair.cx) * pair.k : ocx * sx
    const cy = pair ? mapY(pair.cy) + (ocy - pair.cy) * pair.k : mapY(ocy)
    let k = s
    if (e.type === 'text') k = textK()
    if (pair) k = pair.k
    n.width = e.width * k; n.height = e.height * k
    if (e.type === 'text') { n.fontSize = Math.max(8, Math.round((Number(e.fontSize) || 24) * k)); n.width = Math.min(n.width, target.w * 0.94) }
    n.strokeWidth = e.strokeWidth * s; n.cornerRadius = e.cornerRadius * s
    const sh = e.shadow as { blur: number; x: number; y: number }
    n.shadow = { ...e.shadow, blur: (sh.blur || 0) * s, x: (sh.x || 0) * s, y: (sh.y || 0) * s }
    n.x = cx - n.width / 2; n.y = cy - n.height / 2
    n.x = Math.min(Math.max(n.x, -n.width * 0.4), target.w - n.width * 0.6)
    n.y = Math.min(Math.max(n.y, -n.height * 0.4), target.h - n.height * 0.6)
    return n
  })
}

/* ------------------------------------------------------------------ controle: veelgemaakte fouten */
function lum(hex: string) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{6}|[0-9a-f]{3})/i)
  if (!m) return 0.5
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const contrast = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }

async function checkFrame(f: Frame): Promise<string[]> {
  const out: string[] = []
  const minSide = Math.min(f.w, f.h), story = f.h / f.w > 1.7, banner = minSide <= 320
  const box = new Map<string, { x: number; y: number; w: number; h: number }>()
  for (const e of f.elements) {
    let h = e.height
    if (e.type === 'text') { try { h = (await layoutText(e)).height } catch { /* schatting */ } }
    box.set(e.id, { x: e.x, y: e.y, w: e.width, h })
  }
  const label = (e: El) => `${e.type === 'text' ? `tekst "${String(e.text || '').replace(/\n/g, ' ').slice(0, 28)}"` : `${e.type} "${e.name}"`} (${e.id})`
  const inside = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  let words = 0
  f.elements.forEach((e, i) => {
    if (!e.visible) return
    const b = box.get(e.id)!
    const outPart = (Math.max(0, -b.x) + Math.max(0, b.x + b.w - f.w)) / Math.max(1, b.w) + (Math.max(0, -b.y) + Math.max(0, b.y + b.h - f.h)) / Math.max(1, b.h)
    if (e.type === 'text') {
      words += String(e.text || '').split(/\s+/).filter(Boolean).length
      if (!String(e.text || '').trim()) out.push(`${label(e)} is leeg`)
      if (outPart > 0.01) out.push(`${label(e)} valt (deels) buiten het formaat`)
      const fs = Number(e.fontSize) || 24
      const minFs = banner ? 11 : Math.round(minSide * 0.028)
      if (fs < minFs) out.push(`${label(e)} is ${fs}px: te klein om op mobiel te lezen, minimaal ongeveer ${minFs}px`)
      const m = minSide * 0.04
      if (outPart <= 0.01 && (b.x < m || b.y < m || b.x + b.w > f.w - m || b.y + b.h > f.h - m)) out.push(`${label(e)} staat te dicht op de rand; houd minstens ${Math.round(m)}px marge`)
      if (story && (b.y < f.h * 0.14 || b.y + b.h > f.h * 0.8)) out.push(`${label(e)} staat in de veilige zone van de story (boven 14% of onder 20%); daar vallen profielnaam en knoppen overheen`)
      // contrast met wat eronder ligt
      const c = { x: b.x + b.w / 2, y: b.y + b.h / 2 }
      let under: string[] | null = null, onPhoto = false
      for (let j = i - 1; j >= 0; j--) {
        const o = f.elements[j]
        if (!o.visible || o.type === 'text' || o.type === 'icon' || o.type === 'line') continue
        if (!inside(c, box.get(o.id)!)) continue
        if (o.type === 'image') { onPhoto = !!o.src; under = o.src ? null : [o.fill]; break }
        if ((o.opacity ?? 1) > 0.6) { under = [o.fill]; break }
      }
      if (!under && !onPhoto) under = f.background.type === 'gradient' ? [f.background.color, f.background.color2] : f.background.type === 'image' ? null : [f.background.color]
      if (f.background.type === 'image' && !under) onPhoto = true
      if (onPhoto) out.push(`${label(e)} staat op een foto: controleer in de preview de leesbaarheid en of er geen gezicht of product achter de tekst valt; gebruik zo nodig een vlak of verloop eronder`)
      else if (under) {
        const large = fs >= minSide * 0.05 || (Number(e.fontWeight) >= 700 && fs >= minSide * 0.035)
        const worst = Math.min(...under.map((u) => contrast(String(e.fill), u)))
        if (worst < (large ? 3 : 4.5)) out.push(`${label(e)} heeft te weinig contrast (${worst.toFixed(1)}:1 met ${under.join(' / ')}); minimaal ${large ? '3' : '4,5'}:1`)
      }
      // tekst die buiten zijn knop of vlak steekt
      for (let j = i - 1; j >= 0; j--) {
        const o = f.elements[j]
        if (!o.visible || o.type !== 'rect') continue
        const ob = box.get(o.id)!
        if (inside(c, ob) && ob.w * ob.h < f.w * f.h * 0.3 && (b.x < ob.x - 1 || b.x + b.w > ob.x + ob.w + 1 || b.y < ob.y - 1 || b.y + b.h > ob.y + ob.h + 1)) { out.push(`${label(e)} steekt buiten het vlak "${o.name}" (${o.id}) eronder`); break }
      }
      for (let j = i + 1; j < f.elements.length; j++) {
        const o = f.elements[j]
        if (o.visible && o.type === 'text' && overlap(b, box.get(o.id)!) > 4) out.push(`${label(e)} overlapt met ${label(o)}`)
      }
    } else if (e.type === 'image') {
      if (!e.src) out.push(`${label(e)} is een leeg fotokader`)
      if (outPart > 0.35) out.push(`${label(e)} valt grotendeels buiten het formaat`)
    } else if (e.type === 'icon') {
      if (outPart > 0.01) out.push(`${label(e)} valt (deels) buiten het formaat`)
      if (story && (b.y < f.h * 0.14 || b.y + b.h > f.h * 0.8) && b.w < f.w * 0.5) out.push(`${label(e)} staat in de veilige zone van de story`)
    }
  })
  if (banner && words > 20) out.push(`${words} woorden in een banner van ${f.w}×${f.h}: te veel, houd het bij een korte kop, één voordeel en een knop`)
  if (!banner && words > 40) out.push(`${words} woorden: veel tekst voor een advertentie; kort in tot kop, ondersteuning en call to action`)
  if (f.platform === 'Google Display' && f.duration > 30) out.push(`animatie duurt ${f.duration}s; Google Ads staat maximaal 30s toe`)
  if (!f.elements.some((e) => e.type === 'text')) out.push('er staat geen tekst in dit formaat')
  return out
}

/* ------------------------------------------------------------------ live beelden */
/** Vraagt een open editor om een pixel-exacte render; anders null. */
async function clientRender(designId: string, frameIds: string[], t: number | null, maxSide: number): Promise<Map<string, { bytes: Uint8Array; mime: string }> | null> {
  const reqId = crypto.randomUUID()
  await broadcast(designId, [{ event: 'render-request', payload: { reqId, frameIds, time: t, maxSide } }])
  const start = Date.now()
  let files: { name: string }[] = [], acked = false
  while (Date.now() - start < 12000) {
    await sleep(300)
    const { data } = await db.storage.from('assets').list(`previews/${reqId}`)
    const all = (data || []) as { name: string }[]
    acked = all.some((f) => f.name === '_ack')
    files = all.filter((f) => f.name !== '_ack')
    if (files.length >= frameIds.length) break
    if (!acked && Date.now() - start > 2500) break
  }
  const paths = [...files.map((f) => `previews/${reqId}/${f.name}`), `previews/${reqId}/_ack`]
  if (!files.length) { if (acked) db.storage.from('assets').remove(paths).then(() => {}); return null }
  const map = new Map<string, { bytes: Uint8Array; mime: string }>()
  for (const f of files) {
    const { data } = await db.storage.from('assets').download(`previews/${reqId}/${f.name}`)
    if (data) map.set(f.name.replace(/\.\w+$/, ''), { bytes: new Uint8Array(await data.arrayBuffer()), mime: f.name.endsWith('.png') ? 'image/png' : 'image/jpeg' })
  }
  db.storage.from('assets').remove(paths).then(() => {})
  return map
}

async function previewContent(designId: string, ctx: Ctx, opts: { frame_id?: string; time?: number | null; size?: number; checks?: boolean }) {
  const row = await loadDesign(designId, ctx)
  const frames = (opts.frame_id ? pickFrames(row.data, opts.frame_id) : row.data.frames).slice(0, 8)
  const t = typeof opts.time === 'number' ? opts.time : null
  const size = Math.max(200, Math.min(1400, opts.size || 900))
  const live = await clientRender(designId, frames.map((f) => f.id), t, size)
  const content: Json[] = []
  for (const f of frames) {
    let img = live?.get(f.id)
    let src = 'pixel-exact uit de open editor'
    if (!img) { img = { bytes: await renderFramePng(f, t, size), mime: 'image/png' }; src = 'serverrender (lettertypes en beelden benaderen de editor)' }
    const checks = opts.checks === false ? [] : await checkFrame(f)
    content.push({ type: 'text', text: `${f.name} · frame_id ${f.id} · ${f.w}×${f.h}px${t !== null ? ` · op ${t}s van de animatie` : ''} · ${src}\n${opts.checks === false ? '' : checks.length ? 'Controle, los dit op:\n- ' + checks.join('\n- ') : 'Controle: geen veelgemaakte fouten gevonden. Kijk zelf nog naar uitsnede, hiërarchie en balans.'}` })
    content.push({ type: 'image', data: b64(img.bytes), mimeType: img.mime })
  }
  return content
}

/* ------------------------------------------------------------------ tools */
const S = {
  str: (d: string) => ({ type: 'string', description: d }),
  num: (d: string) => ({ type: 'number', description: d }),
  bool: (d: string) => ({ type: 'boolean', description: d }),
}
const DESIGN = S.str('Id van het ontwerp (uit list_designs of create_design)')
const FRAME = S.str('Id van het formaat (uit get_design). Laat leeg voor het eerste formaat, of gebruik "all" om het in alle formaten te zetten; waarden gelden dan voor het eerste formaat en schalen mee.')
const BOX = { x: S.num('Links in px vanaf de linkerrand van het formaat'), y: S.num('Boven in px vanaf de bovenrand'), width: S.num('Breedte in px'), height: S.num('Hoogte in px') }

const PREVIEWABLE = ['set_background', 'add_text', 'add_shape', 'add_image', 'add_icon', 'update_element', 'delete_element', 'arrange_element', 'animate_element', 'add_many', 'update_many', 'duplicate_element', 'align_elements', 'distribute_elements', 'copy_to_all_formats', 'set_image_crop', 'fit_image', 'animation_preset', 'add_format']
const TOOLS: { name: string; description: string; inputSchema: { type: string; properties: Json; required?: string[] } }[] = [
  { name: 'list_formats', description: 'Toont alle beschikbare advertentieformaten (key, naam, breedte, hoogte, platform) en de standaardsets.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_designs', description: 'Lijst van ontwerpen waar de gebruiker bij kan, nieuwste eerst.', inputSchema: { type: 'object', properties: { search: S.str('Zoekterm in de titel'), scope: { type: 'string', enum: ['mine', 'team', 'all'], description: 'mine = eigen ontwerpen, team = gedeeld, all = alles (standaard)' } } } },
  { name: 'get_design', description: 'Volledige inhoud van een ontwerp: formaten met id, afmetingen, achtergrond en alle elementen (id, type, positie, tekst, kleur, animatie). Gebruik dit voordat je iets aanpast. Laag 0 ligt achteraan.', inputSchema: { type: 'object', properties: { design_id: DESIGN }, required: ['design_id'] } },
  { name: 'create_design', description: 'Maakt een nieuw ontwerp. Geef format-keys (zie list_formats) of een set: social, google, linkedin, demandgen. Geeft de id en de link terug; vraag de gebruiker de link te openen om live mee te kijken.', inputSchema: { type: 'object', properties: { title: S.str('Naam van het ontwerp'), set: { type: 'string', enum: Object.keys(SETS) }, formats: { type: 'array', items: { type: 'string' }, description: 'Format-keys zoals meta-sq, meta-story, g-300x250' }, custom: { type: 'array', items: { type: 'object', properties: { name: S.str('Naam'), width: S.num('Breedte px'), height: S.num('Hoogte px'), platform: S.str('Platform') }, required: ['width', 'height'] }, description: 'Eigen formaten' }, share_with_team: S.bool('Direct delen met het hele team (standaard nee)') }, required: ['title'] } },
  { name: 'add_format', description: 'Voegt een formaat toe aan een ontwerp. Met copy_from_frame_id wordt de inhoud van dat formaat slim meegeschaald.', inputSchema: { type: 'object', properties: { design_id: DESIGN, format: S.str('Format-key (list_formats)'), width: S.num('Eigen breedte'), height: S.num('Eigen hoogte'), name: S.str('Naam bij eigen formaat'), copy_from_frame_id: S.str('Inhoud kopiëren van dit formaat') }, required: ['design_id'] } },
  { name: 'set_frame', description: 'Past instellingen van een formaat aan: naam, animatieduur (seconden, max 30 voor Google Ads) en veilige zones.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, name: S.str('Naam'), duration: S.num('Duur van de animatie in seconden'), safe_zone: S.bool('Veilige zones voor stories tonen') }, required: ['design_id'] } },
  { name: 'set_background', description: 'Achtergrond van een of alle formaten: effen kleur, kleurverloop of foto (URL wordt opgeslagen in Adwerk).', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, type: { type: 'string', enum: ['solid', 'gradient', 'image'] }, color: S.str('Hex-kleur, bijv. #1B213B'), color2: S.str('Tweede kleur bij verloop'), angle: S.num('Hoek van het verloop in graden'), image_url: S.str('Foto-URL of data-URL bij type image') }, required: ['design_id'] } },
  { name: 'add_text', description: `Voegt een tekstblok toe. Lettertypes: ${FONTS.join(', ')} of een andere Google Font.`, inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, text: S.str('De tekst; \\n voor een nieuwe regel'), ...BOX, font_size: S.num('Lettergrootte in px'), font_family: S.str('Lettertype (standaard Poppins)'), font_weight: S.num('400, 500, 600, 700, 800 of 900'), color: S.str('Hex-kleur'), align: { type: 'string', enum: ['left', 'center', 'right'] }, line_height: S.num('Regelafstand, bijv. 1.15'), letter_spacing: S.num('Letterafstand in px'), uppercase: S.bool('Hoofdletters'), italic: S.bool('Cursief'), name: S.str('Laagnaam') }, required: ['design_id', 'text'] } },
  { name: 'add_shape', description: 'Voegt een vorm toe: rect, rounded, pill, ellipse, triangle, star, badge of line. Handig voor knoppen, vlakken en accenten.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, shape: { type: 'string', enum: ['rect', 'rounded', 'pill', 'ellipse', 'triangle', 'star', 'badge', 'line'] }, ...BOX, color: S.str('Vulkleur (hex)'), corner_radius: S.num('Afronding in px'), stroke_color: S.str('Randkleur'), stroke_width: S.num('Randdikte'), opacity: S.num('0 tot 1'), name: S.str('Laagnaam') }, required: ['design_id', 'shape'] } },
  { name: 'add_image', description: 'Bekijk de foto eerst met view_image. Zet een afbeelding op het canvas vanaf een URL of data-URL. Het beeld wordt opgeslagen in de uploads van de gebruiker. Zonder breedte/hoogte past het beeld in de juiste verhouding. Met mask krijg je een vorm (circle, arch, oval, leaf, blob).', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, image_url: S.str('URL of data-URL'), ...BOX, mask: { type: 'string', enum: ['none', 'circle', 'arch', 'oval', 'leaf', 'blob'] }, corner_radius: S.num('Afronding'), focus_x: S.num('Focuspunt in de foto 0 tot 1 (uit view_image), bijv. tussen de ogen'), focus_y: S.num('Focuspunt 0 tot 1'), name: S.str('Laagnaam') }, required: ['design_id', 'image_url'] } },
  { name: 'add_icon', description: 'Zet een icoon uit 200.000+ open iconen (Iconify) op het canvas. Zoek eerst met search_icons.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, icon: S.str('Iconify-id, bijv. "ph:shopping-cart-bold"'), x: BOX.x, y: BOX.y, size: S.num('Grootte in px'), color: S.str('Kleur (hex) voor eenkleurige iconen') }, required: ['design_id', 'icon'] } },
  { name: 'search_icons', description: 'Zoekt open iconen (Engelse zoekwoorden werken het best). Geeft Iconify-id\'s terug voor add_icon.', inputSchema: { type: 'object', properties: { query: S.str('Zoekwoord, bijv. cart, phone, arrow'), pack: S.str('Optioneel pack-prefix, bijv. ph, tabler, lucide, mdi, logos'), limit: S.num('Max aantal (standaard 30)') }, required: ['query'] } },
  { name: 'update_element', description: 'Past een element aan. Geef alleen de eigenschappen die veranderen, bijvoorbeeld {"x":120,"text":"Nu 20% korting","fill":"#EA5F39","fontSize":64}. Mogelijk: x, y, width, height, rotation, opacity, visible, locked, fill, stroke, strokeWidth, cornerRadius, text, fontFamily, fontSize, fontWeight, italic, underline, align, lineHeight, letterSpacing, uppercase, src, mask, cropZoom, cropX, cropY, flipX, flipY, name, shadow {enabled,color,blur,x,y,opacity}.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id van het element'), props: { type: 'object', description: 'De te wijzigen eigenschappen' } }, required: ['design_id', 'element_id', 'props'] } },
  { name: 'delete_element', description: 'Verwijdert een element.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id van het element') }, required: ['design_id', 'element_id'] } },
  { name: 'arrange_element', description: 'Verandert de laagvolgorde: front (helemaal voor), back (helemaal achter), forward of backward (één stap).', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id'), position: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] } }, required: ['design_id', 'element_id', 'position'] } },
  { name: 'animate_element', description: `Animatie voor een element (HTML5, GIF en video). In en uit: ${IN_ANIMS.join(', ')}. Nadruk (herhalend): ${EMPH_ANIMS.join(', ')}. Delay en duration in seconden.`, inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id'), in: { type: 'object', properties: { type: { type: 'string', enum: IN_ANIMS }, delay: S.num('Start na s'), duration: S.num('Duur s') } }, out: { type: 'object', properties: { type: { type: 'string', enum: IN_ANIMS }, delay: S.num('Seconden vóór het einde'), duration: S.num('Duur s') } }, emphasis: { type: 'object', properties: { type: { type: 'string', enum: EMPH_ANIMS }, speed: S.num('Snelheid, 1 = normaal') } } }, required: ['design_id', 'element_id'] } },
  { name: 'add_to_library', description: 'Zet een afbeelding alleen in de uploads (niet op het canvas), optioneel gedeeld met het team.', inputSchema: { type: 'object', properties: { image_url: S.str('URL of data-URL'), name: S.str('Bestandsnaam'), shared: S.bool('Delen met team') }, required: ['image_url'] } },
  { name: 'list_brand_kits', description: 'Merksets van klanten (kleuren, lettertypes, logo-URL\'s) om in de huisstijl te ontwerpen.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_assets', description: 'Afbeeldingen in de uploads van de gebruiker en de gedeelde teamuploads.', inputSchema: { type: 'object', properties: { shared: S.bool('Alleen gedeelde teamuploads') } } },
  // ---- kijken en controleren
  { name: 'get_preview', description: 'LIVE BEELD: geeft een afbeelding van één of alle formaten terug zoals ze er nu uitzien, plus een automatische controle op veelgemaakte fouten (contrast, te kleine tekst, buiten beeld, veilige zones, overlap, tekst op foto, te veel woorden). Heeft iemand het ontwerp open, dan is het beeld pixel-exact uit de editor. Gebruik dit na elke ontwerpstap en los alles op wat je ziet, tot het perfect is. Met time (seconden) zie je een moment uit de animatie.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Eén formaat; leeg = alle formaten (max 8)'), time: S.num('Moment in de animatie in seconden; leeg = eindbeeld'), size: S.num('Langste zijde van het beeld in px (200 tot 1400, standaard 900)'), checks: S.bool('Controle meesturen (standaard ja)') }, required: ['design_id'] } },
  { name: 'check_design', description: 'Alleen de automatische controle op veelgemaakte fouten, zonder beeld. Snel na kleine aanpassingen.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Eén formaat; leeg = alle') }, required: ['design_id'] } },
  { name: 'view_image', description: 'Toont een foto VOLLEDIG (niet uitgesneden) met een raster van 0,1 stappen, zodat je ziet waar gezichten, ogen, producten en lege ruimte zitten. Doe dit vóór je een foto plaatst of uitsnijdt en gebruik de coördinaten in set_image_crop. Geef een element_id of een url.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Afbeeldingselement'), url: S.str('Of een losse afbeeldings-URL'), size: S.num('Langste zijde (standaard 900)') } } },
  { name: 'set_image_crop', description: 'Bepaalt de uitsnede van een foto in zijn kader. focus_x en focus_y (0 tot 1, gemeten in de volledige foto via view_image) komen zo centraal mogelijk in beeld. Kies bij mensen het punt tussen de ogen of iets erboven, zodat hoofd en kin in beeld blijven. zoom 1 = zo ver mogelijk uitgezoomd, hoger = inzoomen.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Afbeeldingselement'), focus_x: S.num('0 = links, 1 = rechts'), focus_y: S.num('0 = boven, 1 = onder'), zoom: S.num('1 of hoger'), flip_x: S.bool('Spiegelen (bijv. zodat iemand naar de tekst kijkt)') }, required: ['design_id', 'element_id'] } },
  { name: 'fit_image', description: 'Past een fotokader aan de foto aan. contain = kader krijgt de verhouding van de foto (niets wordt afgesneden), cover_frame = foto vult het hele formaat als achtergrondlaag.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Afbeeldingselement'), mode: { type: 'string', enum: ['contain', 'cover_frame'] } }, required: ['design_id', 'element_id', 'mode'] } },
  { name: 'list_fonts', description: 'Lettertypes die zeker goed werken (alle Google Fonts kunnen, deze zijn geladen en getest).', inputSchema: { type: 'object', properties: {} } },
  // ---- meerdere dingen tegelijk
  { name: 'add_many', description: 'Voegt in één keer meerdere elementen toe. Elk item heeft "tool" (add_text, add_shape, add_image of add_icon) plus de argumenten van die tool (zonder design_id). Sneller dan losse aanroepen; je ziet de cursor alles één voor één plaatsen.', inputSchema: { type: 'object', properties: { design_id: DESIGN, items: { type: 'array', items: { type: 'object' } }, preview: S.bool('Daarna een live beeld terugsturen') }, required: ['design_id', 'items'] } },
  { name: 'update_many', description: 'Past meerdere elementen in één keer aan: updates = [{element_id, props}] met dezelfde props als update_element.', inputSchema: { type: 'object', properties: { design_id: DESIGN, updates: { type: 'array', items: { type: 'object', properties: { element_id: { type: 'string' }, props: { type: 'object' } } } }, preview: S.bool('Daarna een live beeld terugsturen') }, required: ['design_id', 'updates'] } },
  { name: 'duplicate_element', description: 'Dupliceert een element, optioneel verschoven of naar een ander formaat (meegeschaald).', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Element'), dx: S.num('Verschuiving x'), dy: S.num('Verschuiving y'), to_frame_id: S.str('Naar dit formaat kopiëren') }, required: ['design_id', 'element_id'] } },
  { name: 'align_elements', description: 'Lijnt elementen uit: left, center, right, top, middle, bottom. relative_to frame (het formaat) of selection (de elementen onderling).', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_ids: { type: 'array', items: { type: 'string' } }, align: { type: 'string', enum: ['left', 'center', 'right', 'top', 'middle', 'bottom'] }, relative_to: { type: 'string', enum: ['frame', 'selection'] }, margin: S.num('Marge tot de rand bij relative_to frame') }, required: ['design_id', 'element_ids', 'align'] } },
  { name: 'distribute_elements', description: 'Verdeelt elementen met gelijke tussenruimte, horizontaal of verticaal.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_ids: { type: 'array', items: { type: 'string' } }, axis: { type: 'string', enum: ['horizontal', 'vertical'] } }, required: ['design_id', 'element_ids', 'axis'] } },
  // ---- formaten
  { name: 'copy_to_all_formats', description: 'Zet het ontwerp van één formaat slim om naar alle andere formaten (tekst blijft leesbaar, knoppen schalen mee met hun tekst, stories binnen de veilige zones). Overschrijft de inhoud van die formaten. Controleer daarna elk formaat met get_preview en verfijn per formaat.', inputSchema: { type: 'object', properties: { design_id: DESIGN, from_frame_id: S.str('Bronformaat'), to_frame_ids: { type: 'array', items: { type: 'string' }, description: 'Alleen deze formaten (leeg = alle andere)' } }, required: ['design_id', 'from_frame_id'] } },
  { name: 'delete_format', description: 'Verwijdert een formaat uit het ontwerp.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Formaat') }, required: ['design_id', 'frame_id'] } },
  { name: 'export_image', description: 'Exporteert een formaat als PNG in volle resolutie en geeft een downloadlink. Voor GIF, video en HTML5-zips gebruikt de gebruiker Exporteren in Adwerk.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Formaat'), scale: S.num('1 = ware grootte, 2 = dubbel') }, required: ['design_id', 'frame_id'] } },
  // ---- ontwerpen en projecten
  { name: 'rename_design', description: 'Geeft een ontwerp een nieuwe naam.', inputSchema: { type: 'object', properties: { design_id: DESIGN, title: S.str('Nieuwe naam') }, required: ['design_id', 'title'] } },
  { name: 'duplicate_design', description: 'Kopieert een ontwerp, optioneel naar een project.', inputSchema: { type: 'object', properties: { design_id: DESIGN, title: S.str('Naam van de kopie'), project_id: S.str('In dit project zetten') }, required: ['design_id'] } },
  { name: 'share_design', description: 'Deelt een ontwerp met het hele team of maakt het weer privé; of voegt specifieke collega\'s toe (e-mailadressen).', inputSchema: { type: 'object', properties: { design_id: DESIGN, with_team: S.bool('true = hele team, false = privé'), add_emails: { type: 'array', items: { type: 'string' } }, remove_emails: { type: 'array', items: { type: 'string' } } }, required: ['design_id'] } },
  { name: 'set_template', description: 'Maakt van een ontwerp een teamtemplate (of haalt die status weg).', inputSchema: { type: 'object', properties: { design_id: DESIGN, is_template: S.bool('true of false') }, required: ['design_id', 'is_template'] } },
  { name: 'delete_design', description: 'Verwijdert een eigen ontwerp definitief. Alleen doen als de gebruiker daar expliciet om vraagt; zet confirm op true.', inputSchema: { type: 'object', properties: { design_id: DESIGN, confirm: S.bool('Moet true zijn') }, required: ['design_id', 'confirm'] } },
  { name: 'list_projects', description: 'Projecten (mappen per klant) met het aantal ontwerpen.', inputSchema: { type: 'object', properties: {} } },
  { name: 'create_project', description: 'Maakt een project (map), bijvoorbeeld per klant.', inputSchema: { type: 'object', properties: { name: S.str('Naam, bijv. klantnaam'), share_with_team: S.bool('Zichtbaar voor het team (standaard ja)') }, required: ['name'] } },
  { name: 'update_project', description: 'Hernoemt een project of verandert de zichtbaarheid.', inputSchema: { type: 'object', properties: { project_id: S.str('Project'), name: S.str('Nieuwe naam'), share_with_team: S.bool('Zichtbaar voor het team') }, required: ['project_id'] } },
  { name: 'delete_project', description: 'Verwijdert een eigen project. De ontwerpen erin blijven bestaan (zonder project). Alleen op expliciet verzoek; confirm true.', inputSchema: { type: 'object', properties: { project_id: S.str('Project'), confirm: S.bool('Moet true zijn') }, required: ['project_id', 'confirm'] } },
  { name: 'move_design', description: 'Verplaatst een ontwerp naar een project, of uit een project (project_id leeg).', inputSchema: { type: 'object', properties: { design_id: DESIGN, project_id: S.str('Doelproject; leeg = geen project') }, required: ['design_id'] } },
  // ---- uploads
  { name: 'update_asset', description: 'Hernoemt een upload of deelt hem met het team.', inputSchema: { type: 'object', properties: { asset_id: S.str('Upload (uit list_assets)'), name: S.str('Nieuwe naam'), shared: S.bool('Delen met team') }, required: ['asset_id'] } },
  { name: 'delete_asset', description: 'Verwijdert een eigen upload. Alleen op expliciet verzoek; confirm true.', inputSchema: { type: 'object', properties: { asset_id: S.str('Upload'), confirm: S.bool('Moet true zijn') }, required: ['asset_id', 'confirm'] } },
  // ---- animatie
  { name: 'set_animations', description: 'Zet animaties voor meerdere elementen tegelijk aan, uit of anders. items = [{element_id, in?, out?, emphasis?}] zoals bij animate_element. Gebruik type "none" om een animatie uit te zetten.', inputSchema: { type: 'object', properties: { design_id: DESIGN, items: { type: 'array', items: { type: 'object' } } }, required: ['design_id', 'items'] } },
  { name: 'clear_animations', description: 'Zet alle animaties uit: van één element (element_id) of van een heel formaat (frame_id, of "all").', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Element'), frame_id: S.str('Formaat of "all"') }, required: ['design_id'] } },
  { name: 'animation_preset', description: 'Kant-en-klare animatie voor een heel formaat: stagger_up (alles schuift na elkaar omhoog in, achtergrondvlakken eerst), fade_in (alles vervaagt in), pop_cta (tekst schuift in, de knop ploft en pulseert), ken_burns (foto zoomt langzaam, tekst komt erna), none (alles uit). Houdt rekening met de duur van het formaat.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Formaat of "all"'), preset: { type: 'string', enum: ['stagger_up', 'fade_in', 'pop_cta', 'ken_burns', 'none'] }, duration: S.num('Totale duur van het formaat in seconden (optioneel)') }, required: ['design_id', 'preset'] } },
  { name: 'preview_animation', description: 'Filmstrip van de animatie: beelden op meerdere momenten (standaard 0,3s, 0,8s, 1,5s, halverwege en het einde) zodat je kunt zien of alles goed binnenkomt, niet te druk is en het eindbeeld klopt.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: S.str('Formaat'), times: { type: 'array', items: { type: 'number' }, description: 'Momenten in seconden' }, size: S.num('Langste zijde per beeld (standaard 600)') }, required: ['design_id', 'frame_id'] } },
]

async function call(name: string, a: Json, ctx: Ctx) {
  const num = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d)

  switch (name) {
    case 'list_formats': return ok({ formats: FORMATS, sets: SETS })

    case 'list_designs': {
      let q = db.from('designs').select('id,title,owner_id,visibility,updated_at').order('updated_at', { ascending: false }).limit(60)
      if (a.search) q = q.ilike('title', `%${a.search}%`)
      const { data } = await q
      const { data: mem } = await db.from('design_members').select('design_id').eq('user_id', ctx.userId)
      const memSet = new Set((mem || []).map((m: { design_id: string }) => m.design_id))
      const rows = (data || []).filter((d) => d.owner_id === ctx.userId || d.visibility === 'team' || memSet.has(d.id))
        .filter((d) => a.scope === 'mine' ? d.owner_id === ctx.userId : a.scope === 'team' ? d.owner_id !== ctx.userId : true)
      return ok(rows.map((d) => ({ id: d.id, title: d.title, mine: d.owner_id === ctx.userId, shared_with_team: d.visibility === 'team', updated_at: d.updated_at, url: designUrl(d.id) })))
    }

    case 'get_design': {
      const d = await loadDesign(String(a.design_id), ctx)
      return ok({ id: d.id, title: d.title, url: designUrl(d.id), frames: summarize(d.data) })
    }

    case 'create_design': {
      const keys = [...(Array.isArray(a.formats) ? a.formats as string[] : []), ...(a.set ? SETS[String(a.set)] || [] : [])]
      const frames: Frame[] = keys.map((k) => FORMATS.find((f) => f.key === k)).filter(Boolean).map((f) => makeFrame(f!))
      for (const c of (Array.isArray(a.custom) ? a.custom as Json[] : [])) frames.push(makeFrame({ name: String(c.name || 'Eigen formaat'), w: Math.round(num(c.width, 1080)), h: Math.round(num(c.height, 1080)), platform: String(c.platform || 'Overig') }))
      if (!frames.length) frames.push(makeFrame(FORMATS[0]))
      const { data, error } = await db.from('designs').insert({ title: String(a.title || 'Nieuw ontwerp'), data: { version: 1, frames }, owner_id: ctx.userId, updated_by: ctx.userId, visibility: a.share_with_team ? 'team' : 'private' }).select('id').single()
      if (error) throw new Error('Ontwerp aanmaken mislukt')
      return ok({ id: data.id, url: designUrl(data.id), frames: frames.map((f) => ({ frame_id: f.id, name: f.name, width: f.w, height: f.h })), tip: 'Vraag de gebruiker de url te openen: dan zie je elkaar live werken.' })
    }

    case 'add_format': {
      const id = String(a.design_id)
      let added: Frame | null = null
      const live = new Live(id, ctx, '')
      await live.status('formaat toevoegen')
      await editDesign(id, ctx, (doc) => {
        const preset = a.format ? FORMATS.find((f) => f.key === a.format) : null
        if (!preset && !(a.width && a.height)) throw new Error('Geef een format-key of breedte en hoogte')
        const f = makeFrame(preset || { name: String(a.name || 'Eigen formaat'), w: Math.round(num(a.width, 1080)), h: Math.round(num(a.height, 1080)), platform: 'Overig' })
        const src = a.copy_from_frame_id ? doc.frames.find((x) => x.id === a.copy_from_frame_id) : null
        if (src) {
          f.background = clone(src.background); f.duration = src.duration
          f.elements = src.elements.map((e) => {
            const b = mapBox(src, f, e)
            const n: El = { ...clone(e), id: uid(), x: b.x, y: b.y, width: b.width, height: b.height }
            if (n.type === 'text' && typeof n.fontSize === 'number') n.fontSize = Math.max(6, Math.round((n.fontSize as number) * b.k))
            return n
          })
        }
        doc.frames.push(f); added = f
      })
      return ok({ frame_id: added!.id, name: added!.name, width: added!.w, height: added!.h, elements: added!.elements.length })
    }

    case 'set_frame': {
      const id = String(a.design_id)
      await editDesign(id, ctx, (doc) => {
        for (const f of pickFrames(doc, a.frame_id as string | undefined)) {
          if (a.name) f.name = String(a.name)
          if (a.duration !== undefined) f.duration = Math.max(1, Math.min(60, num(a.duration, f.duration)))
          if (a.safe_zone !== undefined) f.safeZone = !!a.safe_zone
        }
      })
      return ok('Formaat bijgewerkt')
    }

    case 'set_background': {
      const id = String(a.design_id)
      const row = await loadDesign(id, ctx)
      const frames = pickFrames(row.data, a.frame_id as string | undefined)
      const live = new Live(id, ctx, frames[0].id)
      await live.moveTo(frames[0].w * 0.12, frames[0].h * 0.9, 'achtergrond kiezen')
      let img: string | undefined
      if (a.type === 'image' && a.image_url) img = (await importImage(String(a.image_url), ctx)).url
      await live.click()
      await editDesign(id, ctx, (doc) => {
        for (const f of pickFrames(doc, a.frame_id as string | undefined)) {
          f.background = { ...f.background, type: String(a.type || (img ? 'image' : a.color2 ? 'gradient' : 'solid')), ...(a.color ? { color: String(a.color) } : {}), ...(a.color2 ? { color2: String(a.color2) } : {}), ...(a.angle !== undefined ? { angle: num(a.angle, 135) } : {}), ...(img ? { src: img } : {}) }
        }
      })
      await live.status('klaar')
      return ok('Achtergrond ingesteld')
    }

    case 'add_text': case 'add_shape': case 'add_image': case 'add_icon': {
      const id = String(a.design_id)
      const row = await loadDesign(id, ctx)
      const frames = pickFrames(row.data, a.frame_id as string | undefined)
      const ref = frames[0]
      let proto: El
      const label = name === 'add_text' ? 'tekst toevoegen' : name === 'add_shape' ? 'vorm toevoegen' : name === 'add_image' ? 'afbeelding plaatsen' : 'icoon plaatsen'
      const live = new Live(id, ctx, ref.id)
      // eerst de cursor naar een plek bij het paneel, alsof je iets pakt
      live.pos = { x: -ref.w * 0.08, y: ref.h * 0.3 }
      await live.status(label)

      if (name === 'add_text') {
        const fs = num(a.font_size, Math.round(Math.min(ref.w, ref.h) * 0.07))
        const lh = num(a.line_height, 1.15)
        const width = num(a.width, Math.round(ref.w * 0.8))
        const text = String(a.text)
        proto = baseEl('text', String(a.name || text.slice(0, 30)), {
          text, fontFamily: String(a.font_family || 'Poppins'), fontSize: fs, fontWeight: num(a.font_weight, 700), italic: !!a.italic, underline: false,
          align: (a.align as string) || 'left', lineHeight: lh, letterSpacing: num(a.letter_spacing, 0), uppercase: !!a.uppercase, fill: String(a.color || '#1B213B'),
          width, height: textHeight(text, width, fs, lh),
        })
        proto.x = num(a.x, Math.round((ref.w - width) / 2)); proto.y = num(a.y, Math.round(ref.h * 0.1))
        if (a.height) proto.height = num(a.height, proto.height)
      } else if (name === 'add_shape') {
        const shape = String(a.shape)
        const type = shape === 'rounded' || shape === 'pill' ? 'rect' : shape === 'badge' ? 'star' : shape
        const w = num(a.width, Math.round(Math.min(ref.w, ref.h) * 0.3)), h = num(a.height, shape === 'line' ? Math.max(4, Math.round(ref.h * 0.01)) : shape === 'pill' ? Math.round(w * 0.3) : w)
        proto = baseEl(type, String(a.name || { rect: 'Rechthoek', rounded: 'Afgerond vlak', pill: 'Knop', ellipse: 'Cirkel', triangle: 'Driehoek', star: 'Ster', badge: 'Badge', line: 'Lijn' }[shape] || 'Vorm'), {
          width: w, height: h, fill: String(a.color || '#EA5F39'), opacity: num(a.opacity, 1),
          cornerRadius: num(a.corner_radius, shape === 'pill' ? 999 : shape === 'rounded' ? Math.round(Math.min(w, h) * 0.15) : 0),
          ...(a.stroke_color ? { stroke: String(a.stroke_color), strokeWidth: num(a.stroke_width, 2) } : {}),
          ...(type === 'star' ? { points: shape === 'badge' ? 14 : 5, innerRatio: shape === 'badge' ? 0.82 : 0.45 } : {}),
        })
        proto.x = num(a.x, Math.round((ref.w - w) / 2)); proto.y = num(a.y, Math.round((ref.h - h) / 2))
      } else if (name === 'add_image') {
        await live.moveTo(-ref.w * 0.05, ref.h * 0.25, 'afbeelding uploaden')
        const img = await importImage(String(a.image_url), ctx, a.name as string | undefined)
        const ratio = img.w / img.h
        let w = num(a.width, 0), h = num(a.height, 0)
        if (!w && !h) { w = ref.w * 0.6; h = w / ratio; if (h > ref.h * 0.6) { h = ref.h * 0.6; w = h * ratio } }
        else if (w && !h) h = w / ratio
        else if (h && !w) w = h * ratio
        proto = baseEl('image', String(a.name || 'Afbeelding'), { src: img.url, width: Math.round(w), height: Math.round(h), cropZoom: 1, cropX: 0.5, cropY: 0.5, fill: '#D9D6E3', mask: (a.mask as string) || 'none', cornerRadius: num(a.corner_radius, 0) })
        proto.x = num(a.x, Math.round((ref.w - w) / 2)); proto.y = num(a.y, Math.round((ref.h - h) / 2))
        if (a.focus_x !== undefined || a.focus_y !== undefined) {
          const sc = Math.max(w / img.w, h / img.h), cw = w / sc, ch = h / sc, cl = (v: number) => Math.min(1, Math.max(0, v))
          proto.cropX = img.w - cw > 0.5 ? cl((num(a.focus_x, 0.5) * img.w - cw / 2) / (img.w - cw)) : 0.5
          proto.cropY = img.h - ch > 0.5 ? cl((num(a.focus_y, 0.5) * img.h - ch / 2) / (img.h - ch)) : 0.5
        }
      } else {
        const { svg, multi } = await iconSvg(String(a.icon))
        const size = num(a.size, Math.round(Math.min(ref.w, ref.h) * 0.16))
        proto = baseEl('icon', String(a.icon).split(':')[1] || 'Icoon', { iconSvg: svg, iconId: String(a.icon), iconMulti: multi, icon: 'star', fill: String(a.color || '#1B213B'), width: size, height: size, strokeWidth: 2 })
        proto.x = num(a.x, Math.round((ref.w - size) / 2)); proto.y = num(a.y, Math.round((ref.h - size) / 2))
      }

      // cursor naar de plek, klikken, element verschijnt
      await live.moveTo(proto.x + proto.width / 2, proto.y + proto.height / 2, label)
      await live.click()
      const created: { frame_id: string; element_id: string }[] = []
      const full = proto.type === 'text' ? String(proto.text) : ''
      // tekst: eerst leeg neerzetten en dan live "typen"
      const typing = proto.type === 'text' && full.length > 2 && frames.length === 1
      await editDesign(id, ctx, (doc) => {
        for (const f of pickFrames(doc, a.frame_id as string | undefined)) {
          const b = mapBox(ref, f, proto)
          const el = { ...clone(proto), id: uid(), x: b.x, y: b.y, width: b.width, height: b.height } as El
          if (el.type === 'text') { el.fontSize = Math.max(6, Math.round(Number(el.fontSize) * b.k)); if (typing) el.text = full.slice(0, 1) }
          f.elements.push(el)
          created.push({ frame_id: f.id, element_id: el.id })
        }
      })
      if (typing) {
        const elId = created[0].element_id
        const steps = Math.min(14, Math.max(3, Math.ceil(full.length / 4)))
        await live.status('typt…', [elId])
        for (let i = 1; i <= steps; i++) {
          const part = full.slice(0, Math.ceil((full.length * i) / steps))
          await live.send([{ event: 'patch', payload: { frames: [{ id: created[0].frame_id, upserts: [{ ...proto, id: elId, text: part }] }] } }])
          await sleep(55 + Math.random() * 45)
        }
        await editDesign(id, ctx, (doc) => { const { el } = findEl(doc, elId); el.text = full })
      }
      await live.status('klaar', created.filter((c) => c.frame_id === ref.id).map((c) => c.element_id))
      return ok({ created, note: frames.length > 1 ? 'In alle formaten geplaatst, meegeschaald vanaf het eerste formaat.' : undefined })
    }

    case 'search_icons': {
      const r = await fetch(`https://api.iconify.design/search?query=${encodeURIComponent(String(a.query))}&limit=${Math.max(32, Math.min(120, num(a.limit, 30)))}${a.pack ? `&prefix=${encodeURIComponent(String(a.pack))}` : ''}`)
      const j = await r.json() as { icons: string[] }
      return ok({ icons: (j.icons || []).slice(0, num(a.limit, 30)) })
    }

    case 'update_element': {
      const id = String(a.design_id), elId = String(a.element_id)
      const props = (a.props || {}) as Json
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      const live = new Live(id, ctx, frame.id)
      live.pos = { x: el.x + el.width / 2 + 120, y: el.y + el.height / 2 + 160 }
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'aanpassen')
      await live.click([elId])
      const allowed = ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked', 'fill', 'stroke', 'strokeWidth', 'cornerRadius', 'text', 'fontFamily', 'fontSize', 'fontWeight', 'italic', 'underline', 'align', 'lineHeight', 'letterSpacing', 'uppercase', 'src', 'mask', 'cropZoom', 'cropX', 'cropY', 'flipX', 'flipY', 'name', 'shadow', 'points', 'innerRatio', 'blend', 'filters']
      const clean: Json = {}
      for (const [k, v] of Object.entries(props)) {
        const key = k === 'color' ? 'fill' : k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
        if (allowed.includes(key)) clean[key] = v
      }
      if (typeof clean.src === 'string' && !String(clean.src).includes('/storage/v1/object/public/assets/')) clean.src = (await importImage(String(clean.src), ctx)).url
      const moved = ['x', 'y', 'width', 'height', 'rotation'].some((k) => k in clean)
      if (moved) {
        // vloeiend verschuiven/schalen zoals bij slepen
        const nx = num(clean.x, el.x), ny = num(clean.y, el.y), nw = num(clean.width, el.width), nh = num(clean.height, el.height)
        await live.moveTo(nx + nw / 2, ny + nh / 2, 'verplaatsen', [elId])
        await live.send([{ event: 'live', payload: { frameId: frame.id, duration: 0.45, items: [{ id: elId, x: nx, y: ny, width: nw, height: nh, rotation: num(clean.rotation, el.rotation) }] } }])
        await sleep(420)
      }
      if (el.type === 'text' && typeof clean.text === 'string' && !('height' in clean)) clean.height = textHeight(String(clean.text), num(clean.width, el.width), num(clean.fontSize, Number(el.fontSize) || 24), num(clean.lineHeight, Number(el.lineHeight) || 1.15))
      await editDesign(id, ctx, (doc) => { Object.assign(findEl(doc, elId).el, clean) })
      await live.status('klaar', [elId])
      return ok({ updated: elId, props: clean })
    }

    case 'delete_element': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'verwijderen')
      await live.click([elId])
      await sleep(200)
      await editDesign(id, ctx, (doc) => { const f = findEl(doc, elId).frame; f.elements = f.elements.filter((e) => e.id !== elId) })
      await live.status('klaar', [])
      return ok({ deleted: elId })
    }

    case 'arrange_element': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'laag ordenen')
      await live.click([elId])
      await editDesign(id, ctx, (doc) => {
        const { frame: f, index } = findEl(doc, elId)
        const [e] = f.elements.splice(index, 1)
        const j = a.position === 'front' ? f.elements.length : a.position === 'back' ? 0 : a.position === 'forward' ? Math.min(f.elements.length, index + 1) : Math.max(0, index - 1)
        f.elements.splice(j, 0, e)
      })
      await live.status('klaar', [elId])
      return ok('Volgorde aangepast')
    }

    case 'animate_element': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'animeren')
      await live.click([elId])
      await editDesign(id, ctx, (doc) => {
        const e = findEl(doc, elId).el
        const an = e.anim || { in: { type: 'none', delay: 0, duration: 0.6 }, out: { type: 'none', delay: 0, duration: 0.5 }, emph: { type: 'none', speed: 1 } }
        const i = a.in as Json | undefined, o = a.out as Json | undefined, m = a.emphasis as Json | undefined
        if (i) an.in = { type: IN_ANIMS.includes(String(i.type)) ? String(i.type) : an.in.type, delay: num(i.delay, an.in.delay), duration: num(i.duration, an.in.duration) }
        if (o) an.out = { type: IN_ANIMS.includes(String(o.type)) ? String(o.type) : an.out.type, delay: num(o.delay, an.out.delay), duration: num(o.duration, an.out.duration) }
        if (m) an.emph = { type: EMPH_ANIMS.includes(String(m.type)) ? String(m.type) : an.emph.type, speed: num(m.speed, an.emph.speed) }
        e.anim = an
      })
      await live.status('klaar', [elId])
      return ok('Animatie ingesteld. De gebruiker kan op afspelen drukken om het te zien.')
    }

    case 'add_to_library': {
      const r = await importImage(String(a.image_url), ctx, a.name as string | undefined, !!a.shared)
      return ok(r)
    }

    case 'list_brand_kits': {
      const { data } = await db.from('brand_kits').select('id,name,colors,fonts,logos').order('name')
      return ok([{ id: 'daar-om-builtin', name: 'daar-om.nl', colors: ['#1B213B', '#1A5FC4', '#A2D6ED', '#E6A4FF', '#EA5F39'], fonts: ['Poppins', 'Caveat'], logos: [] }, ...(data || [])])
    }

    case 'list_assets': {
      let q = db.from('assets').select('id,name,url,width,height,shared').order('created_at', { ascending: false }).limit(80)
      q = a.shared ? q.eq('shared', true) : q.or(`owner_id.eq.${ctx.userId},shared.eq.true`)
      const { data } = await q
      return ok(data || [])
    }
    /* ---------------- kijken en controleren */
    case 'get_preview': return { content: await previewContent(String(a.design_id), ctx, { frame_id: a.frame_id as string | undefined, time: a.time as number | undefined, size: a.size as number | undefined, checks: a.checks as boolean | undefined }) }

    case 'check_design': {
      const row = await loadDesign(String(a.design_id), ctx)
      const frames = a.frame_id ? pickFrames(row.data, String(a.frame_id)) : row.data.frames
      const out: string[] = []
      for (const f of frames) { const c = await checkFrame(f); out.push(`${f.name} (${f.id}): ${c.length ? '\n- ' + c.join('\n- ') : 'geen problemen gevonden'}`) }
      return ok(out.join('\n\n'))
    }

    case 'view_image': {
      let src = a.url ? String(a.url) : ''
      if (!src && a.element_id) { const row = await loadDesign(String(a.design_id), ctx); src = String(findEl(row.data, String(a.element_id)).el.src || '') }
      if (!src) throw new Error('Geef een element_id van een afbeelding of een url')
      const r = await renderImageGrid(src, Math.max(300, Math.min(1400, num(a.size, 900))))
      return { content: [{ type: 'text', text: `Volledige foto, ${r.w}×${r.h}px (verhouding ${(r.w / r.h).toFixed(2)}). Rasterlijnen per 0,1; de roze lijnen zijn het midden. Gebruik deze waarden als focus_x en focus_y in set_image_crop.` }, { type: 'image', data: b64(r.png), mimeType: 'image/png' }] }
    }

    case 'set_image_crop': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      if (el.type !== 'image' || !el.src) throw new Error('Dit is geen afbeelding met een foto')
      const d = await imageDims(String(el.src))
      if (!d) throw new Error('Foto kon niet worden geladen')
      const zoom = Math.max(1, num(a.zoom, Number(el.cropZoom) || 1))
      const s = Math.max(el.width / d.w, el.height / d.h) * zoom, cw = el.width / s, ch = el.height / s
      const fx = num(a.focus_x, 0.5), fy = num(a.focus_y, 0.5)
      const cropX = d.w - cw > 0.5 ? Math.min(1, Math.max(0, (fx * d.w - cw / 2) / (d.w - cw))) : 0.5
      const cropY = d.h - ch > 0.5 ? Math.min(1, Math.max(0, (fy * d.h - ch / 2) / (d.h - ch))) : 0.5
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'uitsnede kiezen')
      await live.click([elId])
      await editDesign(id, ctx, (doc) => { Object.assign(findEl(doc, elId).el, { cropZoom: zoom, cropX: r1(cropX * 1000) / 1000, cropY: r1(cropY * 1000) / 1000, ...(a.flip_x !== undefined ? { flipX: !!a.flip_x } : {}) }) })
      await live.status('klaar', [elId])
      const visible = { left: r1(((d.w - cw) * cropX) / d.w * 100) / 100, top: r1(((d.h - ch) * cropY) / d.h * 100) / 100, width: r1(cw / d.w * 100) / 100, height: r1(ch / d.h * 100) / 100 }
      return ok({ element_id: elId, zoom, visible_part_of_photo: visible, tip: 'Controleer met get_preview of hoofden, handen en het product helemaal in beeld zijn.' })
    }

    case 'fit_image': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { el, frame } = findEl(row.data, elId)
      const d = el.src ? await imageDims(String(el.src)) : null
      if (!d) throw new Error('Foto kon niet worden geladen')
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'kader passend maken')
      await live.click([elId])
      await editDesign(id, ctx, (doc) => {
        const { el: e, frame: f, index } = findEl(doc, elId)
        if (a.mode === 'cover_frame') { Object.assign(e, { x: 0, y: 0, width: f.w, height: f.h, cropZoom: 1, cropX: 0.5, cropY: 0.5, mask: 'none', cornerRadius: 0 }); f.elements.splice(index, 1); f.elements.unshift(e) }
        else { const h = e.width * d.h / d.w; Object.assign(e, { y: e.y + (e.height - h) / 2, height: Math.round(h), cropZoom: 1, cropX: 0.5, cropY: 0.5 }) }
      })
      await live.status('klaar', [elId])
      return ok('Kader aangepast')
    }

    case 'list_fonts': return ok({ fonts: FONTS, tip: 'Poppins (koppen vet, tekst regular) en Caveat (handgeschreven accent) zijn de huisstijl van daar-om.nl. Combineer maximaal twee lettertypes.' })

    /* ---------------- meerdere dingen tegelijk */
    case 'add_many': {
      const results: unknown[] = []
      for (const it of (Array.isArray(a.items) ? a.items as Json[] : [])) {
        const tool = String(it.tool)
        if (!['add_text', 'add_shape', 'add_image', 'add_icon'].includes(tool)) { results.push({ error: `Onbekende tool ${tool}` }); continue }
        try { const r = await call(tool, { ...it, design_id: a.design_id }, ctx) as { content: { text: string }[] }; results.push({ tool, ...JSON.parse(r.content[0].text) }) }
        catch (e) { results.push({ tool, error: (e as Error).message }) }
      }
      return ok(results)
    }

    case 'update_many': {
      const results: unknown[] = []
      for (const u of (Array.isArray(a.updates) ? a.updates as Json[] : [])) {
        try { await call('update_element', { design_id: a.design_id, element_id: u.element_id, props: u.props }, ctx); results.push({ element_id: u.element_id, ok: true }) }
        catch (e) { results.push({ element_id: u.element_id, error: (e as Error).message }) }
      }
      return ok(results)
    }

    case 'duplicate_element': {
      const id = String(a.design_id), elId = String(a.element_id)
      const row = await loadDesign(id, ctx)
      const { frame, el } = findEl(row.data, elId)
      const live = new Live(id, ctx, frame.id)
      await live.moveTo(el.x + el.width / 2, el.y + el.height / 2, 'dupliceren')
      await live.click([elId])
      let newId = ''
      await editDesign(id, ctx, (doc) => {
        const { el: e, frame: f } = findEl(doc, elId)
        const target = a.to_frame_id ? pickFrames(doc, String(a.to_frame_id))[0] : f
        const n = clone(e); n.id = uid(); newId = n.id
        if (target.id !== f.id) { const b = mapBox(f, target, e); Object.assign(n, { x: b.x, y: b.y, width: b.width, height: b.height }); if (n.type === 'text') n.fontSize = Math.max(6, Math.round(Number(n.fontSize) * b.k)) }
        n.x += num(a.dx, target.id === f.id ? 24 : 0); n.y += num(a.dy, target.id === f.id ? 24 : 0)
        target.elements.push(n)
      })
      await live.status('klaar', [newId])
      return ok({ element_id: newId })
    }

    case 'align_elements': case 'distribute_elements': {
      const id = String(a.design_id), ids = (a.element_ids || []) as string[]
      if (!ids.length) throw new Error('Geef element_ids')
      const row = await loadDesign(id, ctx)
      const first = findEl(row.data, ids[0])
      const live = new Live(id, ctx, first.frame.id)
      await live.moveTo(first.el.x + first.el.width / 2, first.el.y + first.el.height / 2, name === 'align_elements' ? 'uitlijnen' : 'verdelen', ids)
      await live.click(ids)
      await editDesign(id, ctx, (doc) => {
        const els = ids.map((i) => findEl(doc, i).el), f = findEl(doc, ids[0]).frame
        if (name === 'align_elements') {
          const sel = a.relative_to === 'selection' && els.length > 1, m = num(a.margin, 0)
          const minX = sel ? Math.min(...els.map((e) => e.x)) : m, maxX = sel ? Math.max(...els.map((e) => e.x + e.width)) : f.w - m
          const minY = sel ? Math.min(...els.map((e) => e.y)) : m, maxY = sel ? Math.max(...els.map((e) => e.y + e.height)) : f.h - m
          for (const e of els) {
            if (a.align === 'left') e.x = minX
            if (a.align === 'right') e.x = maxX - e.width
            if (a.align === 'center') e.x = (minX + maxX) / 2 - e.width / 2
            if (a.align === 'top') e.y = minY
            if (a.align === 'bottom') e.y = maxY - e.height
            if (a.align === 'middle') e.y = (minY + maxY) / 2 - e.height / 2
          }
        } else {
          const hor = a.axis !== 'vertical'
          const sorted = [...els].sort((p, q) => (hor ? p.x - q.x : p.y - q.y))
          const start = hor ? sorted[0].x : sorted[0].y
          const end = hor ? sorted[sorted.length - 1].x + sorted[sorted.length - 1].width : sorted[sorted.length - 1].y + sorted[sorted.length - 1].height
          const total = sorted.reduce((s, e) => s + (hor ? e.width : e.height), 0)
          const gap = (end - start - total) / Math.max(1, sorted.length - 1)
          let pos = start
          for (const e of sorted) { if (hor) e.x = pos; else e.y = pos; pos += (hor ? e.width : e.height) + gap }
        }
      })
      await live.status('klaar', ids)
      return ok('Klaar')
    }

    /* ---------------- formaten */
    case 'copy_to_all_formats': {
      const id = String(a.design_id), from = String(a.from_frame_id)
      const live = new Live(id, ctx, from)
      await live.status('formaten omzetten')
      let count = 0
      await editDesign(id, ctx, (doc) => {
        const src = pickFrames(doc, from)[0]
        const targets = doc.frames.filter((f) => f.id !== src.id && (!Array.isArray(a.to_frame_ids) || (a.to_frame_ids as string[]).includes(f.id)))
        for (const t of targets) { t.elements = smartResize(src, t); t.background = clone(src.background); t.duration = src.duration; count++ }
      })
      return ok({ converted_formats: count, tip: 'Bekijk elk formaat met get_preview; vooral smalle banners (728×90, 320×50) en stories hebben vaak een eigen indeling nodig.' })
    }

    case 'delete_format': {
      const id = String(a.design_id)
      await editDesign(id, ctx, (doc) => {
        if (doc.frames.length <= 1) throw new Error('Een ontwerp heeft minstens één formaat nodig')
        const f = pickFrames(doc, String(a.frame_id))[0]
        doc.frames = doc.frames.filter((x) => x.id !== f.id)
      })
      return ok('Formaat verwijderd')
    }

    case 'export_image': {
      const row = await loadDesign(String(a.design_id), ctx)
      const f = pickFrames(row.data, String(a.frame_id))[0]
      const scale = Math.max(0.25, Math.min(3, num(a.scale, 1)))
      const live = await clientRender(row.id, [f.id], null, Math.round(Math.max(f.w, f.h) * scale))
      const got = live?.get(f.id)
      const bytes = got?.mime === 'image/png' ? got.bytes : await renderFramePng(f, null, Math.max(f.w, f.h) * scale)
      const path = `${ctx.userId}/exports/${crypto.randomUUID()}.png`
      await db.storage.from('assets').upload(path, bytes, { contentType: 'image/png' })
      return ok({ url: db.storage.from('assets').getPublicUrl(path).data.publicUrl, width: Math.round(f.w * scale), height: Math.round(f.h * scale) })
    }

    /* ---------------- ontwerpen en projecten */
    case 'rename_design': {
      const d = await loadDesign(String(a.design_id), ctx)
      await db.from('designs').update({ title: String(a.title), updated_by: ctx.userId }).eq('id', d.id)
      return ok('Naam aangepast')
    }
    case 'duplicate_design': {
      const d = await loadDesign(String(a.design_id), ctx)
      const doc = clone(d.data)
      for (const f of doc.frames) { f.id = uid(); f.elements.forEach((e) => { e.id = uid() }) }
      const { data, error } = await db.from('designs').insert({ title: String(a.title || `${d.title} (kopie)`), data: doc, owner_id: ctx.userId, updated_by: ctx.userId, visibility: d.visibility, folder_id: a.project_id || (d as unknown as { folder_id: string | null }).folder_id || null }).select('id').single()
      if (error) throw new Error('Kopiëren mislukt')
      return ok({ id: data.id, url: designUrl(data.id) })
    }
    case 'share_design': {
      const d = await loadDesign(String(a.design_id), ctx)
      if (a.with_team !== undefined) {
        if (d.owner_id !== ctx.userId) throw new Error('Alleen de eigenaar kan de zichtbaarheid aanpassen')
        await db.from('designs').update({ visibility: a.with_team ? 'team' : 'private' }).eq('id', d.id)
      }
      const emails = [...((a.add_emails || []) as string[]), ...((a.remove_emails || []) as string[])]
      if (emails.length) {
        if (d.owner_id !== ctx.userId) throw new Error('Alleen de eigenaar kan collega\'s toevoegen')
        const { data: profs } = await db.from('profiles').select('id,email').in('email', emails.map((e) => e.toLowerCase()))
        const byMail = new Map((profs || []).map((p: { id: string; email: string }) => [p.email.toLowerCase(), p.id]))
        for (const e of (a.add_emails || []) as string[]) { const uidp = byMail.get(e.toLowerCase()); if (uidp) await db.from('design_members').upsert({ design_id: d.id, user_id: uidp }) }
        for (const e of (a.remove_emails || []) as string[]) { const uidp = byMail.get(e.toLowerCase()); if (uidp) await db.from('design_members').delete().eq('design_id', d.id).eq('user_id', uidp) }
      }
      return ok('Delen bijgewerkt')
    }
    case 'set_template': {
      const d = await loadDesign(String(a.design_id), ctx)
      await db.from('designs').update({ is_template: !!a.is_template }).eq('id', d.id)
      return ok(a.is_template ? 'Staat nu bij de teamtemplates' : 'Geen template meer')
    }
    case 'delete_design': {
      if (a.confirm !== true) throw new Error('Zet confirm op true, en alleen als de gebruiker dit expliciet vroeg')
      const d = await loadDesign(String(a.design_id), ctx)
      if (d.owner_id !== ctx.userId) throw new Error('Je kunt alleen je eigen ontwerpen verwijderen')
      await db.from('designs').delete().eq('id', d.id)
      return ok('Ontwerp verwijderd')
    }
    case 'list_projects': {
      const { data } = await db.from('folders').select('id,name,owner_id,visibility').order('name')
      const rows = (data || []).filter((f: { owner_id: string; visibility: string }) => f.owner_id === ctx.userId || f.visibility === 'team')
      const out = []
      for (const f of rows as { id: string; name: string; owner_id: string; visibility: string }[]) {
        const { count } = await db.from('designs').select('id', { count: 'exact', head: true }).eq('folder_id', f.id)
        out.push({ id: f.id, name: f.name, mine: f.owner_id === ctx.userId, shared_with_team: f.visibility === 'team', designs: count || 0 })
      }
      return ok(out)
    }
    case 'create_project': {
      const { data, error } = await db.from('folders').insert({ name: String(a.name), owner_id: ctx.userId, visibility: a.share_with_team === false ? 'private' : 'team' }).select('id,name').single()
      if (error) throw new Error('Project aanmaken mislukt')
      return ok(data)
    }
    case 'update_project': {
      const { data: f } = await db.from('folders').select('*').eq('id', String(a.project_id)).maybeSingle()
      if (!f || (f.owner_id !== ctx.userId && f.visibility !== 'team')) throw new Error('Project niet gevonden')
      const patch: Json = {}
      if (a.name) patch.name = String(a.name)
      if (a.share_with_team !== undefined) { if (f.owner_id !== ctx.userId) throw new Error('Alleen de eigenaar kan de zichtbaarheid aanpassen'); patch.visibility = a.share_with_team ? 'team' : 'private' }
      await db.from('folders').update(patch).eq('id', f.id)
      return ok('Project bijgewerkt')
    }
    case 'delete_project': {
      if (a.confirm !== true) throw new Error('Zet confirm op true, en alleen als de gebruiker dit expliciet vroeg')
      const { data: f } = await db.from('folders').select('*').eq('id', String(a.project_id)).maybeSingle()
      if (!f || f.owner_id !== ctx.userId) throw new Error('Je kunt alleen je eigen projecten verwijderen')
      await db.from('designs').update({ folder_id: null }).eq('folder_id', f.id)
      await db.from('folders').delete().eq('id', f.id)
      return ok('Project verwijderd; de ontwerpen staan nu zonder project')
    }
    case 'move_design': {
      const d = await loadDesign(String(a.design_id), ctx)
      if (a.project_id) { const { data: f } = await db.from('folders').select('id,owner_id,visibility').eq('id', String(a.project_id)).maybeSingle(); if (!f || (f.owner_id !== ctx.userId && f.visibility !== 'team')) throw new Error('Project niet gevonden') }
      await db.from('designs').update({ folder_id: a.project_id || null }).eq('id', d.id)
      return ok(a.project_id ? 'Verplaatst naar het project' : 'Uit het project gehaald')
    }

    /* ---------------- uploads */
    case 'update_asset': {
      const { data: as } = await db.from('assets').select('id,owner_id').eq('id', String(a.asset_id)).maybeSingle()
      if (!as || as.owner_id !== ctx.userId) throw new Error('Alleen je eigen uploads')
      const patch: Json = {}
      if (a.name) patch.name = String(a.name)
      if (a.shared !== undefined) patch.shared = !!a.shared
      await db.from('assets').update(patch).eq('id', as.id)
      return ok('Upload bijgewerkt')
    }
    case 'delete_asset': {
      if (a.confirm !== true) throw new Error('Zet confirm op true, en alleen als de gebruiker dit expliciet vroeg')
      const { data: as } = await db.from('assets').select('id,owner_id,path').eq('id', String(a.asset_id)).maybeSingle()
      if (!as || as.owner_id !== ctx.userId) throw new Error('Alleen je eigen uploads')
      await db.storage.from('assets').remove([as.path])
      await db.from('assets').delete().eq('id', as.id)
      return ok('Upload verwijderd')
    }

    /* ---------------- animatie */
    case 'set_animations': {
      const results: unknown[] = []
      for (const it of (Array.isArray(a.items) ? a.items as Json[] : [])) {
        try { await call('animate_element', { ...it, design_id: a.design_id }, ctx); results.push({ element_id: it.element_id, ok: true }) }
        catch (e) { results.push({ element_id: it.element_id, error: (e as Error).message }) }
      }
      return ok(results)
    }
    case 'clear_animations': {
      const id = String(a.design_id)
      const none = () => ({ in: { type: 'none', delay: 0, duration: 0.6 }, out: { type: 'none', delay: 0, duration: 0.5 }, emph: { type: 'none', speed: 1 } })
      await editDesign(id, ctx, (doc) => {
        if (a.element_id) findEl(doc, String(a.element_id)).el.anim = none()
        else for (const f of pickFrames(doc, String(a.frame_id || 'all'))) f.elements.forEach((e) => { e.anim = none() })
      })
      return ok('Animaties uitgezet')
    }
    case 'animation_preset': {
      const id = String(a.design_id), preset = String(a.preset)
      await editDesign(id, ctx, (doc) => {
        for (const f of pickFrames(doc, String(a.frame_id || 'all'))) {
          if (a.duration) f.duration = Math.max(1, Math.min(30, num(a.duration, f.duration)))
          const els = f.elements.filter((e) => e.visible)
          const big = (e: El) => e.width * e.height > f.w * f.h * 0.5
          const isCta = (e: El) => e.type === 'rect' && e.cornerRadius > 0 && e.width < f.w * 0.7 && e.height < f.h * 0.25
          const ctaText = (e: El) => e.type === 'text' && els.some((c) => isCta(c) && e.x + e.width / 2 > c.x && e.x + e.width / 2 < c.x + c.width && e.y + e.height / 2 > c.y && e.y + e.height / 2 < c.y + c.height)
          let step = 0
          const order = [...els].sort((p, q) => (big(q) ? 1 : 0) - (big(p) ? 1 : 0) || p.y - q.y)
          for (const e of order) {
            const an = { in: { type: 'none', delay: 0, duration: 0.6 }, out: { type: 'none', delay: 0, duration: 0.5 }, emph: { type: 'none', speed: 1 } }
            if (preset === 'stagger_up') an.in = big(e) ? { type: 'fade', delay: 0, duration: 0.5 } : { type: 'slideUp', delay: r1(0.15 + step++ * 0.18), duration: 0.6 }
            if (preset === 'fade_in') an.in = { type: 'fade', delay: r1(step++ * 0.12), duration: 0.7 }
            if (preset === 'pop_cta') {
              if (isCta(e) || ctaText(e)) { an.in = { type: 'pop', delay: 1.2, duration: 0.5 }; an.emph = { type: 'pulse', speed: 1 } }
              else an.in = big(e) ? { type: 'fade', delay: 0, duration: 0.4 } : { type: 'slideUp', delay: r1(0.1 + step++ * 0.2), duration: 0.6 }
            }
            if (preset === 'ken_burns') {
              if (e.type === 'image' && big(e)) { an.in = { type: 'zoomOut', delay: 0, duration: Math.max(1, f.duration - 0.2) } }
              else an.in = { type: 'fade', delay: r1(0.4 + step++ * 0.2), duration: 0.6 }
            }
            e.anim = an
          }
        }
      })
      return ok('Animatie ingesteld. Bekijk het resultaat met preview_animation.')
    }
    case 'preview_animation': {
      const row = await loadDesign(String(a.design_id), ctx)
      const f = pickFrames(row.data, String(a.frame_id))[0]
      const times = (Array.isArray(a.times) && a.times.length ? a.times as number[] : [0.3, 0.8, 1.5, f.duration / 2, f.duration]).slice(0, 8)
      const content: Json[] = [{ type: 'text', text: `Filmstrip van ${f.name} (${f.duration}s)` }]
      for (const t of times) content.push(...(await previewContent(row.id, ctx, { frame_id: f.id, time: t, size: num(a.size, 600), checks: false })))
      return { content }
    }
  }
  throw new Error(`Onbekende tool: ${name}`)
}

/* ------------------------------------------------------------------ MCP JSON-RPC */
async function sha256(s: string) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
}

async function auth(req: Request): Promise<Ctx | null> {
  const url = new URL(req.url)
  const fromPath = url.pathname.split('/').filter(Boolean).pop() || ''
  const header = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  const token = fromPath.startsWith('adw_') ? fromPath : header.startsWith('adw_') ? header : url.searchParams.get('key') || ''
  if (!token.startsWith('adw_')) return null
  const { data } = await db.from('api_tokens').select('id,user_id,name').eq('token_hash', await sha256(token)).maybeSingle()
  if (!data) return null
  db.from('api_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {})
  return { userId: data.user_id, agentName: data.name || 'Claude', agentKey: `agent:${data.id}` }
}

const INSTRUCTIONS = `Adwerk is de ontwerptool van daar-om.nl voor social ads, HTML5-bannersets en GIF's. Jij werkt live mee: wie het ontwerp open heeft, ziet jouw cursor en elke wijziging direct. Geef de gebruiker altijd de url van het ontwerp.

WERKWIJZE
1. Begrijp de opdracht: klant, doel (bereik, klikken, leads), doelgroep, kanaal en formaten. Haal de huisstijl op met list_brand_kits.
2. list_designs of create_design (een set: social, google, linkedin, demandgen). Zet het ontwerp in het project van de klant (list_projects, create_project, move_design).
3. Ontwerp eerst één hoofdformaat (meestal 1080×1080). Gebruik add_many om in één keer op te bouwen.
4. Kijk ALTIJD met get_preview (of preview: true bij een tool) en los alles op wat de controle meldt én wat je zelf ziet. Herhaal tot het echt goed is. Stop nooit zonder een laatste get_preview van elk formaat.
5. Zet daarna om met copy_to_all_formats en controleer en verfijn elk formaat apart: een 728×90 of 320×50 heeft een eigen indeling nodig (logo links, korte kop midden, knop rechts), een story houdt boven 14% en onder 20% vrij.
6. Animatie: animation_preset of set_animations, controleer met preview_animation. Kort en rustig: alles binnen 2 seconden in beeld, één nadruk-animatie op de knop. Google Ads max 30s.

FOTO'S (de meest gemaakte fouten)
- Bekijk een foto altijd eerst volledig met view_image voordat je hem plaatst of uitsnijdt.
- Snij nooit hoofden, kin, voorhoofd, handen of voeten van personen af en snij nooit door gewrichten (pols, elleboog, knie, enkel). Laat ruimte boven het hoofd.
- Zet de ogen op ongeveer een derde van boven. Gebruik set_image_crop met focus_x en focus_y op het punt tussen de ogen (iets erboven bij close-ups).
- Laat een persoon de advertentie in kijken (richting de tekst), niet eruit; spiegel met flip_x als dat de foto niet onnatuurlijk maakt (nooit bij tekst, logo's of merkproducten in beeld).
- Producten helemaal in beeld, niet afgesneden aan de rand. Groepsfoto's: niemand half in beeld.
- Gebruik een mask (circle, arch) alleen als het onderwerp er ruim in past.
- Geen tekst over gezichten of het product. Tekst op een foto: zet een vlak of donker verloop eronder of kies een rustig deel van de foto.
- Vergroot kleine foto's niet sterk op (wazig). Voorkom dat een foto als achtergrond de tekst onleesbaar maakt.

TEKST EN OPMAAK
- Hiërarchie: één duidelijke kop (groot en vet), hooguit één ondersteunende regel, één call to action als knop. In banners nog korter.
- Leesbaar op mobiel: kop op 1080px minimaal ~60px, bodytekst minimaal ~30px; in kleine banners minimaal 11 tot 12px.
- Contrast minimaal 4,5:1 (grote koppen 3:1). Wit op Spot Oranje (#EA5F39) is te zwak; gebruik #CC4A25 of donkere tekst.
- Marge: houd ongeveer 5% van de korte zijde vrij aan alle randen. Lijn elementen op elkaar uit (align_elements), gelijke tussenruimtes (distribute_elements).
- Knoppen: tekst gecentreerd in het vlak (zelfde breedte en x als de knop, align center), ruim binnen de knop.
- Maximaal twee lettertypes. Geen woorden die halverwege afbreken: maak het tekstvak breder of de letter kleiner.
- Schrijf in het Nederlands, actief en concreet; gebruik je of u zoals de klant. Gebruik geen gedachtestreepjes in teksten.
- Logo altijd zichtbaar en niet vervormd, op een rustige plek met ruimte eromheen.

COÖRDINATEN
Pixels binnen een formaat, 0,0 is linksboven. Laag 0 ligt achteraan; nieuwe elementen komen vooraan (arrange_element om te ordenen). frame_id "all" plaatst iets in alle formaten, meegeschaald vanaf het eerste.

VEILIGHEID
Verwijder ontwerpen, projecten of uploads alleen als de gebruiker daar expliciet om vraagt (confirm: true).`

async function rpc(msg: { jsonrpc: string; id?: string | number; method: string; params?: Json }, ctx: Ctx) {
  const { id, method, params } = msg
  const res = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (id === undefined) return null // notificatie
  try {
    switch (method) {
      case 'initialize': return res({ protocolVersion: (params?.protocolVersion as string) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'adwerk', title: 'Adwerk', version: '1.0.0' }, instructions: INSTRUCTIONS })
      case 'ping': return res({})
      case 'tools/list': return res({ tools: TOOLS.map((t) => PREVIEWABLE.includes(t.name) && !t.inputSchema.properties.preview ? { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, preview: S.bool('Stuur na afloop direct een live beeld en controle van het formaat terug (aanrader)') } } } : t) })
      case 'tools/call': {
        try {
          const name = String(params?.name), args = (params?.arguments || {}) as Json
          const out = await call(name, args, ctx) as { content: Json[] }
          if (args.preview === true && PREVIEWABLE.includes(name) && args.design_id) {
            let fid = args.frame_id as string | undefined
            if (!fid || fid === 'all') {
              try { const txt = String((out.content[0] as { text?: string }).text || ''); const m = txt.match(/"frame_id":\s*"([^"]+)"/); if (m) fid = m[1] } catch { /* geen id */ }
              if (!fid && args.element_id) { const row = await loadDesign(String(args.design_id), ctx); fid = findEl(row.data, String(args.element_id)).frame.id }
            }
            out.content.push(...await previewContent(String(args.design_id), ctx, { frame_id: fid && fid !== 'all' ? fid : undefined }))
          }
          return res(out)
        }
        catch (e) { return res({ content: [{ type: 'text', text: (e as Error).message }], isError: true }) }
      }
      case 'resources/list': return res({ resources: [] })
      case 'prompts/list': return res({ prompts: [] })
      default: return err(-32601, `Methode ${method} wordt niet ondersteund`)
    }
  } catch (e) { return err(-32603, (e as Error).message) }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const ctx = await auth(req)
  if (!ctx) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Ongeldige of ingetrokken Adwerk-sleutel. Maak een nieuwe aan in Adwerk via Claude koppelen.' }, id: null }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } })
  if (req.method === 'GET') return new Response('Adwerk MCP: gebruik POST (Streamable HTTP)', { status: 405, headers: { ...CORS, Allow: 'POST' } })
  if (req.method === 'DELETE') return new Response(null, { status: 200, headers: CORS })
  let body: unknown
  try { body = await req.json() } catch { return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }) }
  const batch = Array.isArray(body)
  const out = (await Promise.all((batch ? body as never[] : [body as never]).map((m) => rpc(m, ctx)))).filter(Boolean)
  if (!out.length) return new Response(null, { status: 202, headers: CORS })
  return new Response(JSON.stringify(batch ? out : out[0]), { headers: { ...CORS, 'Content-Type': 'application/json' } })
})
