// What an artifact preview may load. Previews run in a sandboxed frame with no
// access to the app, and this policy limits what they can reach: the
// only requests allowed are scripts, styles and fonts from a few public code
// hosts. Images must be inline (data: or blob:), so a preview cannot leak what is
// in the conversation through an image address. Pure.

/** How a preview tells the app about an error on its page. */
export const ERROR_MESSAGE_TYPE = 'chaudecal-artifact-error'
/** How a preview tells the app that a link was clicked, which a preview does not follow. */
export const LINK_MESSAGE_TYPE = 'chaudecal-artifact-link'

/** The private scheme the app serves previews under. */
export const ARTIFACT_SCHEME = 'chaudecal-artifact'

/** Public hosts a preview may load code, styles and fonts from. */
export const ARTIFACT_CODE_HOSTS = ['https://esm.sh', 'https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://cdnjs.cloudflare.com']

const FONT_HOSTS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']

/** The Content Security Policy sent with every preview. */
export function artifactCsp(): string {
  const code = ARTIFACT_CODE_HOSTS.join(' ')
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob: ${code}`,
    `style-src 'unsafe-inline' ${code} ${FONT_HOSTS[0]}`,
    `font-src data: ${code} ${FONT_HOSTS.join(' ')}`,
    'img-src data: blob:',
    'media-src data: blob:',
    `connect-src ${code}`,
    'worker-src blob:',
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'"
  ].join('; ')
}

/** Whether a frame inside the app window may go to this address: only previews and blank pages. */
export function frameUrlAllowed(url: string): boolean {
  return url.startsWith(`${ARTIFACT_SCHEME}://`) || url === 'about:blank' || url === 'about:srcdoc'
}
