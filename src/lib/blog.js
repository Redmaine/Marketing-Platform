// Shared helpers for the Blog admin section (slug/excerpt generation + a
// small dependency-free markdown -> HTML renderer, just enough for a
// pre-publish preview — the live site does its own real rendering).

export function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Appends -2, -3, … until the slug is unique among this client's other posts.
export function uniqueSlug(baseSlug, clientId, posts, excludeId) {
  const taken = new Set(
    posts.filter((p) => p.client_id === clientId && p.id !== excludeId).map((p) => p.slug)
  )
  if (!taken.has(baseSlug) || !baseSlug) return baseSlug
  let n = 2
  while (taken.has(`${baseSlug}-${n}`)) n++
  return `${baseSlug}-${n}`
}

export function autoExcerpt(body, max = 150) {
  const plain = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> link text
    .replace(/[#*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  return `${plain.slice(0, max).replace(/\s+\S*$/, '')}…`
}

// Minimal markdown -> HTML for the preview pane. Not exhaustive — headings,
// bold/italic, links, images, unordered lists, and paragraphs.
export function markdownToHtml(md) {
  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n')
  const html = []
  let inList = false

  function closeList() {
    if (inList) { html.push('</ul>'); inList = false }
  }
  function inline(text) {
    let t = escapeHtml(text)
    t = t.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px" />')
    t = t.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>')
    return t
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (!line) { closeList(); continue }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) { closeList(); const level = h[1].length + 1; html.push(`<h${level}>${inline(h[2])}</h${level}>`); continue }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) { html.push('<ul>'); inList = true }
      html.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`)
      continue
    }
    closeList()
    html.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return html.join('\n')
}
