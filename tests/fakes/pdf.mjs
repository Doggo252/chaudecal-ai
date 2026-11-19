// Builds a small, valid PDF with real text in it, so tests need no binary fixture.
// Each page is a list of lines, drawn top to bottom in Helvetica.

const escape = (text) => text.replace(/([\\()])/g, '\\$1')

/** @param {string[][]} pages */
export function makePdf(pages) {
  const objects = []
  const add = (body) => objects.push(body) && objects.length
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = objects.length + 1 + pages.length * 2
  const pageIds = []
  for (const lines of pages) {
    const draw = lines.length ? `BT /F1 12 Tf 72 720 Td 16 TL ${lines.map((l) => `(${escape(l)}) Tj T*`).join(' ')} ET` : ''
    const contentId = add(`<< /Length ${Buffer.byteLength(draw, 'latin1')} >>\nstream\n${draw}\nendstream`)
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)

  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
