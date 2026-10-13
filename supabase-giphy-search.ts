// GIF's zoeken voor de Adwerk-chat. De GIPHY-sleutel staat als geheim (GIPHY_API_KEY) in Supabase
// en komt nooit in de browser. Alleen ingelogde teamleden kunnen deze functie aanroepen (JWT verplicht).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS })
  const key = Deno.env.get('GIPHY_API_KEY')
  if (!key) return json({ error: 'not_configured' })
  let q = '', offset = 0
  try { const b = await req.json(); q = String(b.q || '').slice(0, 80); offset = Math.max(0, Math.min(4900, Number(b.offset) || 0)) } catch { /* trending */ }
  const url = q.trim()
    ? `https://api.giphy.com/v1/gifs/search?api_key=${key}&q=${encodeURIComponent(q)}&limit=24&offset=${offset}&rating=g&lang=nl`
    : `https://api.giphy.com/v1/gifs/trending?api_key=${key}&limit=24&offset=${offset}&rating=g`
  const r = await fetch(url)
  if (!r.ok) return json({ error: r.status === 429 ? 'rate_limited' : 'giphy_error' })
  const j = await r.json() as { data: { id: string; title: string; images: { fixed_height: { url: string; width: string; height: string }; fixed_height_still: { url: string } } }[] }
  return json({ gifs: j.data.map((g) => ({ id: g.id, title: g.title, url: g.images.fixed_height.url, still: g.images.fixed_height_still.url, w: +g.images.fixed_height.width, h: +g.images.fixed_height.height })) })
})
