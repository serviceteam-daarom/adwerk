// Adwerk MCP-server: laat een AI-agent (zoals Claude) live ontwerpen maken en bewerken.
// Transport: MCP Streamable HTTP (stateless, JSON-antwoorden). Toegang met een persoonlijke sleutel uit Adwerk.
// Elke actie verschijnt live bij wie het ontwerp open heeft: een cursor die zich als een mens beweegt, daarna de wijziging.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const APP_URL = 'https://serviceteam-daarom.github.io/adwerk/'
const db = createClient(SB_URL, SRK, { auth: { persistSession: false } })

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

/* ------------------------------------------------------------------ tools */
const S = {
  str: (d: string) => ({ type: 'string', description: d }),
  num: (d: string) => ({ type: 'number', description: d }),
  bool: (d: string) => ({ type: 'boolean', description: d }),
}
const DESIGN = S.str('Id van het ontwerp (uit list_designs of create_design)')
const FRAME = S.str('Id van het formaat (uit get_design). Laat leeg voor het eerste formaat, of gebruik "all" om het in alle formaten te zetten; waarden gelden dan voor het eerste formaat en schalen mee.')
const BOX = { x: S.num('Links in px vanaf de linkerrand van het formaat'), y: S.num('Boven in px vanaf de bovenrand'), width: S.num('Breedte in px'), height: S.num('Hoogte in px') }

const TOOLS = [
  { name: 'list_formats', description: 'Toont alle beschikbare advertentieformaten (key, naam, breedte, hoogte, platform) en de standaardsets.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_designs', description: 'Lijst van ontwerpen waar de gebruiker bij kan, nieuwste eerst.', inputSchema: { type: 'object', properties: { search: S.str('Zoekterm in de titel'), scope: { type: 'string', enum: ['mine', 'team', 'all'], description: 'mine = eigen ontwerpen, team = gedeeld, all = alles (standaard)' } } } },
  { name: 'get_design', description: 'Volledige inhoud van een ontwerp: formaten met id, afmetingen, achtergrond en alle elementen (id, type, positie, tekst, kleur, animatie). Gebruik dit voordat je iets aanpast. Laag 0 ligt achteraan.', inputSchema: { type: 'object', properties: { design_id: DESIGN }, required: ['design_id'] } },
  { name: 'create_design', description: 'Maakt een nieuw ontwerp. Geef format-keys (zie list_formats) of een set: social, google, linkedin, demandgen. Geeft de id en de link terug; vraag de gebruiker de link te openen om live mee te kijken.', inputSchema: { type: 'object', properties: { title: S.str('Naam van het ontwerp'), set: { type: 'string', enum: Object.keys(SETS) }, formats: { type: 'array', items: { type: 'string' }, description: 'Format-keys zoals meta-sq, meta-story, g-300x250' }, custom: { type: 'array', items: { type: 'object', properties: { name: S.str('Naam'), width: S.num('Breedte px'), height: S.num('Hoogte px'), platform: S.str('Platform') }, required: ['width', 'height'] }, description: 'Eigen formaten' }, share_with_team: S.bool('Direct delen met het hele team (standaard nee)') }, required: ['title'] } },
  { name: 'add_format', description: 'Voegt een formaat toe aan een ontwerp. Met copy_from_frame_id wordt de inhoud van dat formaat slim meegeschaald.', inputSchema: { type: 'object', properties: { design_id: DESIGN, format: S.str('Format-key (list_formats)'), width: S.num('Eigen breedte'), height: S.num('Eigen hoogte'), name: S.str('Naam bij eigen formaat'), copy_from_frame_id: S.str('Inhoud kopiëren van dit formaat') }, required: ['design_id'] } },
  { name: 'set_frame', description: 'Past instellingen van een formaat aan: naam, animatieduur (seconden, max 30 voor Google Ads) en veilige zones.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, name: S.str('Naam'), duration: S.num('Duur van de animatie in seconden'), safe_zone: S.bool('Veilige zones voor stories tonen') }, required: ['design_id'] } },
  { name: 'set_background', description: 'Achtergrond van een of alle formaten: effen kleur, kleurverloop of foto (URL wordt opgeslagen in Adwerk).', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, type: { type: 'string', enum: ['solid', 'gradient', 'image'] }, color: S.str('Hex-kleur, bijv. #1B213B'), color2: S.str('Tweede kleur bij verloop'), angle: S.num('Hoek van het verloop in graden'), image_url: S.str('Foto-URL of data-URL bij type image') }, required: ['design_id'] } },
  { name: 'add_text', description: `Voegt een tekstblok toe. Lettertypes: ${FONTS.join(', ')} of een andere Google Font.`, inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, text: S.str('De tekst; \\n voor een nieuwe regel'), ...BOX, font_size: S.num('Lettergrootte in px'), font_family: S.str('Lettertype (standaard Poppins)'), font_weight: S.num('400, 500, 600, 700, 800 of 900'), color: S.str('Hex-kleur'), align: { type: 'string', enum: ['left', 'center', 'right'] }, line_height: S.num('Regelafstand, bijv. 1.15'), letter_spacing: S.num('Letterafstand in px'), uppercase: S.bool('Hoofdletters'), italic: S.bool('Cursief'), name: S.str('Laagnaam') }, required: ['design_id', 'text'] } },
  { name: 'add_shape', description: 'Voegt een vorm toe: rect, rounded, pill, ellipse, triangle, star, badge of line. Handig voor knoppen, vlakken en accenten.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, shape: { type: 'string', enum: ['rect', 'rounded', 'pill', 'ellipse', 'triangle', 'star', 'badge', 'line'] }, ...BOX, color: S.str('Vulkleur (hex)'), corner_radius: S.num('Afronding in px'), stroke_color: S.str('Randkleur'), stroke_width: S.num('Randdikte'), opacity: S.num('0 tot 1'), name: S.str('Laagnaam') }, required: ['design_id', 'shape'] } },
  { name: 'add_image', description: 'Zet een afbeelding op het canvas vanaf een URL of data-URL. Het beeld wordt opgeslagen in de uploads van de gebruiker. Zonder breedte/hoogte past het beeld in de juiste verhouding. Met mask krijg je een vorm (circle, arch, oval, leaf, blob).', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, image_url: S.str('URL of data-URL'), ...BOX, mask: { type: 'string', enum: ['none', 'circle', 'arch', 'oval', 'leaf', 'blob'] }, corner_radius: S.num('Afronding'), name: S.str('Laagnaam') }, required: ['design_id', 'image_url'] } },
  { name: 'add_icon', description: 'Zet een icoon uit 200.000+ open iconen (Iconify) op het canvas. Zoek eerst met search_icons.', inputSchema: { type: 'object', properties: { design_id: DESIGN, frame_id: FRAME, icon: S.str('Iconify-id, bijv. "ph:shopping-cart-bold"'), x: BOX.x, y: BOX.y, size: S.num('Grootte in px'), color: S.str('Kleur (hex) voor eenkleurige iconen') }, required: ['design_id', 'icon'] } },
  { name: 'search_icons', description: 'Zoekt open iconen (Engelse zoekwoorden werken het best). Geeft Iconify-id\'s terug voor add_icon.', inputSchema: { type: 'object', properties: { query: S.str('Zoekwoord, bijv. cart, phone, arrow'), pack: S.str('Optioneel pack-prefix, bijv. ph, tabler, lucide, mdi, logos'), limit: S.num('Max aantal (standaard 30)') }, required: ['query'] } },
  { name: 'update_element', description: 'Past een element aan. Geef alleen de eigenschappen die veranderen, bijvoorbeeld {"x":120,"text":"Nu 20% korting","fill":"#EA5F39","fontSize":64}. Mogelijk: x, y, width, height, rotation, opacity, visible, locked, fill, stroke, strokeWidth, cornerRadius, text, fontFamily, fontSize, fontWeight, italic, underline, align, lineHeight, letterSpacing, uppercase, src, mask, cropZoom, cropX, cropY, flipX, flipY, name, shadow {enabled,color,blur,x,y,opacity}.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id van het element'), props: { type: 'object', description: 'De te wijzigen eigenschappen' } }, required: ['design_id', 'element_id', 'props'] } },
  { name: 'delete_element', description: 'Verwijdert een element.', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id van het element') }, required: ['design_id', 'element_id'] } },
  { name: 'arrange_element', description: 'Verandert de laagvolgorde: front (helemaal voor), back (helemaal achter), forward of backward (één stap).', inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id'), position: { type: 'string', enum: ['front', 'back', 'forward', 'backward'] } }, required: ['design_id', 'element_id', 'position'] } },
  { name: 'animate_element', description: `Animatie voor een element (HTML5, GIF en video). In en uit: ${IN_ANIMS.join(', ')}. Nadruk (herhalend): ${EMPH_ANIMS.join(', ')}. Delay en duration in seconden.`, inputSchema: { type: 'object', properties: { design_id: DESIGN, element_id: S.str('Id'), in: { type: 'object', properties: { type: { type: 'string', enum: IN_ANIMS }, delay: S.num('Start na s'), duration: S.num('Duur s') } }, out: { type: 'object', properties: { type: { type: 'string', enum: IN_ANIMS }, delay: S.num('Seconden vóór het einde'), duration: S.num('Duur s') } }, emphasis: { type: 'object', properties: { type: { type: 'string', enum: EMPH_ANIMS }, speed: S.num('Snelheid, 1 = normaal') } } }, required: ['design_id', 'element_id'] } },
  { name: 'add_to_library', description: 'Zet een afbeelding alleen in de uploads (niet op het canvas), optioneel gedeeld met het team.', inputSchema: { type: 'object', properties: { image_url: S.str('URL of data-URL'), name: S.str('Bestandsnaam'), shared: S.bool('Delen met team') }, required: ['image_url'] } },
  { name: 'list_brand_kits', description: 'Merksets van klanten (kleuren, lettertypes, logo-URL\'s) om in de huisstijl te ontwerpen.', inputSchema: { type: 'object', properties: {} } },
  { name: 'list_assets', description: 'Afbeeldingen in de uploads van de gebruiker en de gedeelde teamuploads.', inputSchema: { type: 'object', properties: { shared: S.bool('Alleen gedeelde teamuploads') } } },
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

const INSTRUCTIONS = `Adwerk is de ontwerptool van daar-om.nl voor social ads, HTML5-bannersets en GIF's.
Werkwijze: 1) list_designs of create_design, 2) get_design voor formaat- en element-id's, 3) bouw met add_text, add_shape, add_image, add_icon, set_background, 4) verfijn met update_element, arrange_element en animate_element.
Coördinaten zijn pixels binnen een formaat (0,0 is linksboven). Laag 0 ligt achteraan; nieuwe elementen komen vooraan.
Wie het ontwerp open heeft, ziet jouw cursor live bewegen en je wijzigingen direct verschijnen. Geef de gebruiker de url zodat die kan meekijken.
Ontwerp in de huisstijl van de klant (list_brand_kits). Gebruik geen gedachtestreepjes in teksten.`

async function rpc(msg: { jsonrpc: string; id?: string | number; method: string; params?: Json }, ctx: Ctx) {
  const { id, method, params } = msg
  const res = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const err = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (id === undefined) return null // notificatie
  try {
    switch (method) {
      case 'initialize': return res({ protocolVersion: (params?.protocolVersion as string) || '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'adwerk', title: 'Adwerk', version: '1.0.0' }, instructions: INSTRUCTIONS })
      case 'ping': return res({})
      case 'tools/list': return res({ tools: TOOLS })
      case 'tools/call': {
        try { return res(await call(String(params?.name), (params?.arguments || {}) as Json, ctx)) }
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
