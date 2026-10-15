// Feedbacklink voor klanten: bekijken en reageren zonder account. Toegang alleen met de geheime token uit Adwerk.
import { createClient } from 'npm:@supabase/supabase-js@2'

const SB_URL = Deno.env.get('SUPABASE_URL')!
const SRK = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const db = createClient(SB_URL, SRK, { auth: { persistSession: false } })
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// eenvoudige rem tegen misbruik: max 20 reacties per link per 10 minuten
const recent = new Map<string, number[]>()

async function broadcast(designId: string, event: string, payload: unknown) {
  try {
    await fetch(`${SB_URL}/realtime/v1/api/broadcast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: SRK, Authorization: `Bearer ${SRK}` },
      body: JSON.stringify({ messages: [{ topic: `comments:${designId}`, event, payload, private: false }] }),
    })
  } catch { /* live is een extraatje */ }
}

const publicComment = (c: Record<string, unknown>, names: Map<string, { name: string; avatar: string | null; color: string | null }>) => {
  const p = c.author_id ? names.get(String(c.author_id)) : null
  return { id: c.id, frame_id: c.frame_id, x: c.x, y: c.y, parent_id: c.parent_id, body: c.body, resolved: c.resolved, created_at: c.created_at, author: p ? { name: p.name, avatar: p.avatar, color: p.color, team: true } : { name: c.guest_name || 'Gast', team: false } }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  let b: Record<string, unknown>
  try { b = await req.json() } catch { return json({ error: 'bad_request' }, 400) }
  const token = String(b.token || '')
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return json({ error: 'not_found' }, 404)
  const { data: link } = await db.from('share_links').select('*').eq('token', token).maybeSingle()
  if (!link || link.revoked) return json({ error: 'not_found' }, 404)

  const { data: design } = await db.from('designs').select('id,title,data,updated_at,owner_id').eq('id', link.design_id).maybeSingle()
  if (!design) return json({ error: 'not_found' }, 404)

  const loadNames = async (ids: string[]) => {
    const uniq = [...new Set(ids.filter(Boolean))]
    if (!uniq.length) return new Map()
    const { data } = await db.from('profiles').select('id,full_name,email,avatar_url,color').in('id', uniq)
    return new Map((data || []).map((p: { id: string; full_name: string; email: string; avatar_url: string | null; color: string | null }) => [p.id, { name: p.full_name || p.email.split('@')[0], avatar: p.avatar_url, color: p.color }]))
  }

  if (b.action === 'get') {
    db.from('share_links').update({ last_used_at: new Date().toISOString() }).eq('id', link.id).then(() => {})
    const { data: cs } = await db.from('comments').select('*').eq('design_id', design.id).order('created_at')
    const names = await loadNames((cs || []).map((c: { author_id: string }) => c.author_id))
    // brief: alleen als die zichtbaar is voor de klant, zonder interne velden
    const b = design.data?.brief as { showClient?: boolean; fields?: { hidden?: boolean }[] } | undefined
    const brief = b && b.showClient !== false ? { fields: (b.fields || []).filter((f) => !f.hidden) } : null
    return json({ design: { id: design.id, title: design.title, frames: design.data?.frames || [], updated_at: design.updated_at, brief }, can_comment: link.can_comment, comments: (cs || []).map((c: Record<string, unknown>) => publicComment(c, names)) })
  }

  if (b.action === 'comment') {
    if (!link.can_comment) return json({ error: 'read_only' }, 403)
    const name = String(b.name || '').trim().slice(0, 60)
    const body = String(b.body || '').trim().slice(0, 2000)
    if (!name || !body) return json({ error: 'missing' }, 400)
    const now = Date.now(), hits = (recent.get(link.id) || []).filter((t) => now - t < 600000)
    if (hits.length >= 20) return json({ error: 'rate_limited' }, 429)
    recent.set(link.id, [...hits, now])
    const frames = (design.data?.frames || []) as { id: string }[]
    const frameId = frames.some((f) => f.id === b.frame_id) ? String(b.frame_id) : null
    let parent: string | null = null
    if (b.parent_id) { const { data: pc } = await db.from('comments').select('id').eq('id', String(b.parent_id)).eq('design_id', design.id).maybeSingle(); parent = pc?.id || null }
    const row = {
      design_id: design.id, frame_id: frameId, parent_id: parent, body, guest_name: name, author_id: null,
      x: typeof b.x === 'number' && isFinite(b.x) ? b.x : null, y: typeof b.y === 'number' && isFinite(b.y) ? b.y : null,
    }
    const { data: c, error } = await db.from('comments').insert(row).select('*').single()
    if (error) return json({ error: 'failed' }, 500)
    const out = publicComment(c, new Map())
    await broadcast(design.id, 'comment', { ...c, author: out.author })
    return json({ comment: out })
  }

  return json({ error: 'unknown_action' }, 400)
})
