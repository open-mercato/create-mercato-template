/**
 * Opaque files (spec, Opaque files). A file is text when it decodes as UTF-8
 * with a fatal decoder and has no NUL byte. A file that is not text is
 * allowed only when its extension is an image or a font and its first bytes
 * match that format's signature. Archive and database extensions are opaque
 * even when the content is text. Every other file that is not text is
 * opaque: an `error` unless its exact path is in `allowFiles`.
 */

export type ContentKind = 'text' | 'media' | 'opaque'

const utf8 = new TextDecoder('utf-8', { fatal: true })

export const archiveExtensions: readonly string[] = ['zip', 'tar', 'tgz', 'gz', 'bz2', 'xz', '7z', 'rar', 'jar']
export const databaseExtensions: readonly string[] = ['sql', 'dump', 'bak', 'sqlite', 'sqlite3', 'db']

const ascii = (text: string) => Buffer.from(text, 'latin1')
const startsWith = (content: Buffer, signature: Buffer, offset = 0) =>
  content.length >= offset + signature.length && content.subarray(offset, offset + signature.length).equals(signature)

/** An ISO BMFF file (`ftyp` box at offset 4) whose major or compatible brands include one of `brands`. */
function hasBrand(content: Buffer, brands: string[]): boolean {
  if (!startsWith(content, ascii('ftyp'), 4) || content.length < 16) return false
  const size = Math.min(content.readUInt32BE(0), content.length)
  const wanted = new Set(brands)
  if (wanted.has(content.toString('latin1', 8, 12))) return true
  for (let offset = 16; offset + 4 <= size; offset += 4) if (wanted.has(content.toString('latin1', offset, offset + 4))) return true
  return false
}

const trueType = Buffer.of(0x00, 0x01, 0x00, 0x00)

/** The signature check of each image extension (`svg` is text) and font extension. */
const signatures: Readonly<Record<string, (content: Buffer) => boolean>> = {
  png: (content) => startsWith(content, Buffer.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
  jpg: (content) => startsWith(content, Buffer.of(0xff, 0xd8, 0xff)),
  jpeg: (content) => startsWith(content, Buffer.of(0xff, 0xd8, 0xff)),
  gif: (content) => startsWith(content, ascii('GIF87a')) || startsWith(content, ascii('GIF89a')),
  webp: (content) => startsWith(content, ascii('RIFF')) && startsWith(content, ascii('WEBP'), 8),
  avif: (content) => hasBrand(content, ['avif', 'avis']),
  bmp: (content) => startsWith(content, ascii('BM')),
  ico: (content) => startsWith(content, Buffer.of(0x00, 0x00, 0x01, 0x00)),
  icns: (content) => startsWith(content, ascii('icns')),
  woff: (content) => startsWith(content, ascii('wOFF')),
  woff2: (content) => startsWith(content, ascii('wOF2')),
  ttf: (content) => startsWith(content, trueType) || startsWith(content, ascii('true')),
  otf: (content) => startsWith(content, ascii('OTTO')) || startsWith(content, trueType),
  // Embedded OpenType: the magic number 0x504C, little-endian, at offset 34.
  eot: (content) => startsWith(content, Buffer.of(0x4c, 0x50), 34),
}

/** The lower-cased extension of the last path segment, or `''`. */
export function extensionOf(filePath: string): string {
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** True when the content decodes as UTF-8 with a fatal decoder and has no NUL byte. */
export function isText(content: Buffer): boolean {
  if (content.includes(0)) return false
  try {
    utf8.decode(content)
    return true
  } catch {
    return false
  }
}

/**
 * `text`: scanned as text. `media`: an image or font whose signature matches
 * its extension, exported without a text scan. `opaque`: an archive or
 * database extension, or any other content that is not text.
 */
export function classifyContent(filePath: string, content: Buffer): ContentKind {
  const extension = extensionOf(filePath)
  if (archiveExtensions.includes(extension) || databaseExtensions.includes(extension)) return 'opaque'
  if (isText(content)) return 'text'
  const signature = signatures[extension]
  return signature !== undefined && signature(content) ? 'media' : 'opaque'
}
