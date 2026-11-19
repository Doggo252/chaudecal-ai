// Reading replies aloud. The computer's own voices read the words; code, links
// and markup are left out or said plainly. Pure.

/** What a reply sounds like read aloud: the words, without the markup. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\1[ \t]*(\n|$)|$)/g, ' (A block of code is left out here.) ')
    .replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, ' (A formula is left out here.) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*\|?[-: |]+\|[-: |]*$/gm, '')
    .replace(/\|/g, ', ')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?\S|\S)\1/g, '$2')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}
