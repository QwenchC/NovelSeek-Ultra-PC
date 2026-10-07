import { assert } from './protocol';

export interface ExportBook { title: string; author?: string | null; chapters: { title: string; body: string }[]; outline?: string | null; language?: string; identifier?: string }
export function escapeXml(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === '&') result += '&amp;'; else if (char === '<') result += '&lt;'; else if (char === '>') result += '&gt;';
    else if (char === '"') result += '&quot;'; else if (char === "'") result += '&apos;';
    else result += code === 9 || code === 10 || code === 13 || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff) ? char : '\uFFFD';
  }
  return result;
}
const utf8 = new TextEncoder();
const crcTable = Array.from({ length: 256 }, (_, index) => { let v = index; for (let i = 0; i < 8; i++) v = (v >>> 1) ^ (v & 1 ? 0xedb88320 : 0); return v >>> 0; });
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const b of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ b) & 255]; return (crc ^ 0xffffffff) >>> 0; }
/** Dependency-free ZIP STORE. All sizes bounded below ZIP64 limits; UTF-8 filenames, exact CRC. */
export function createStoredZip(entries: { path: string; text: string }[]): Uint8Array {
  assert(entries.length > 0 && entries.length <= 10_000 && new Set(entries.map(e => e.path)).size === entries.length, 'ZIP 条目数量无效或重复');
  const chunks: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    assert(entry.path && !entry.path.startsWith('/') && !entry.path.split('/').some(p => !p || p === '..' || p === '.') && !/[\\:\u0000-\u001f]/.test(entry.path), 'ZIP 路径无效');
    const name = utf8.encode(entry.path), content = utf8.encode(entry.text), crc = crc32(content);
    assert(name.length <= 65_535 && content.length <= 64_000_000 && offset + content.length <= 128_000_000, '导出包过大，请分卷导出');
    const local = new Uint8Array(30 + name.length); const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true); l.setUint16(4, 20, true); l.setUint16(6, 0x800, true); l.setUint16(12, 0x21, true);
    l.setUint32(14, crc, true); l.setUint32(18, content.length, true); l.setUint32(22, content.length, true); l.setUint16(26, name.length, true); local.set(name, 30);
    const directory = new Uint8Array(46 + name.length); const d = new DataView(directory.buffer);
    d.setUint32(0, 0x02014b50, true); d.setUint16(4, 20, true); d.setUint16(6, 20, true); d.setUint16(8, 0x800, true); d.setUint16(14, 0x21, true);
    d.setUint32(16, crc, true); d.setUint32(20, content.length, true); d.setUint32(24, content.length, true); d.setUint16(28, name.length, true); d.setUint32(42, offset, true); directory.set(name, 46);
    chunks.push(local, content); central.push(directory); offset += local.length + content.length;
  }
  const centralLength = central.reduce((n, x) => n + x.length, 0); const end = new Uint8Array(22); const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, entries.length, true); e.setUint16(10, entries.length, true); e.setUint32(12, centralLength, true); e.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralLength + end.length); let cursor = 0;
  for (const chunk of [...chunks, ...central, end]) { result.set(chunk, cursor); cursor += chunk.length; } return result;
}
function validateBook(book: ExportBook): void {
  assert(typeof book.title === 'string' && Array.isArray(book.chapters) && book.chapters.length <= 2_000, '导出书籍结构无效');
  assert(book.chapters.every(c => typeof c.title === 'string' && typeof c.body === 'string'), '导出章节结构无效');
  assert(book.chapters.reduce((n, c) => n + c.body.length + c.title.length, book.title.length + (book.author?.length ?? 0) + (book.outline?.length ?? 0)) <= 10_000_000, '导出内容超过1000万字符，请分卷导出');
}
const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
function xhtml(title: string, lang: string): string { return `${declaration}<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}"><head><title>${escapeXml(title || 'Untitled')}</title><style>body { line-height: 1.7; } p { white-space: pre-wrap; } h1 { font-size: 1.6em; }</style></head><body>`; }
export function exportEpub(book: ExportBook): Uint8Array {
  validateBook(book); const lang = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(book.language ?? '') ? book.language! : 'zh-CN';
  const docs = [{ path: 'title.xhtml', title: book.title || 'Untitled', body: book.author ?? '' },
    ...(book.outline?.trim() ? [{ path: 'outline.xhtml', title: '大纲 / Outline', body: book.outline }] : []),
    ...book.chapters.map((c, i) => ({ path: `chapter-${i + 1}.xhtml`, title: c.title, body: c.body }))];
  return createStoredZip([
    // OCF: first, uncompressed, without extra fields or BOM.
    { path: 'mimetype', text: 'application/epub+zip' },
    { path: 'META-INF/container.xml', text: `${declaration}<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
    { path: 'EPUB/package.opf', text: `${declaration}<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${lang}"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(book.identifier ?? 'urn:uuid:' + crypto.randomUUID())}</dc:identifier><dc:title>${escapeXml(book.title || 'Untitled')}</dc:title><dc:language>${lang}</dc:language>${book.author ? `<dc:creator>${escapeXml(book.author)}</dc:creator>` : ''}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${docs.map((d, i) => `<item id="doc-${i}" href="${d.path}" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${docs.map((_, i) => `<itemref idref="doc-${i}"/>`).join('')}</spine></package>` },
    { path: 'EPUB/nav.xhtml', text: `${xhtml('目录 / Contents', lang)}<nav epub:type="toc" id="toc"><h1>目录 / Contents</h1><ol>${docs.map(d => `<li><a href="${d.path}">${escapeXml(d.title || 'Untitled')}</a></li>`).join('')}</ol></nav></body></html>` },
    ...docs.map(d => ({ path: 'EPUB/' + d.path, text: `${xhtml(d.title, lang)}<h1>${escapeXml(d.title)}</h1>${d.body.replace(/\r\n?/g, '\n').split('\n').map(line => `<p>${escapeXml(line)}</p>`).join('')}</body></html>` })),
  ]);
}
export function exportDocx(book: ExportBook): Uint8Array {
  validateBook(book); const rels = 'http://schemas.openxmlformats.org/package/2006/relationships', w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paragraph = (text: string, style = 'Normal', pageBreak = false) => `<w:p><w:pPr><w:pStyle w:val="${style}"/>${pageBreak ? '<w:pageBreakBefore/>' : ''}</w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
  const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n').map(line => paragraph(line)).join('');
  return createStoredZip([
    { path: '[Content_Types].xml', text: `${declaration}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { path: '_rels/.rels', text: `${declaration}<Relationships xmlns="${rels}"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="core" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { path: 'word/_rels/document.xml.rels', text: `${declaration}<Relationships xmlns="${rels}"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    { path: 'docProps/core.xml', text: `${declaration}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(book.title)}</dc:title><dc:creator>${escapeXml(book.author ?? '')}</dc:creator></cp:coreProperties>` },
    { path: 'word/styles.xml', text: `${declaration}<w:styles xmlns:w="${w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="SimSun"/><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>` },
    { path: 'word/document.xml', text: `${declaration}<w:document xmlns:w="${w}"><w:body>${paragraph(book.title || 'Untitled', 'Title')}${book.author ? paragraph(book.author) : ''}${book.outline?.trim() ? paragraph('大纲 / Outline', 'Heading1', true) + lines(book.outline) : ''}${book.chapters.map(c => paragraph(c.title, 'Heading1', true) + lines(c.body)).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>` },
  ]);
}
export function exportBook(book: ExportBook, format: 'epub' | 'docx'): Uint8Array { return format === 'epub' ? exportEpub(book) : exportDocx(book); }
