import { createHash } from 'node:crypto';

/**
 * Real PDF files built byte by byte for the PDF upload tests (no binary
 * fixtures in the repo, no PDF-writing dependency). Each one is a valid
 * PDF 1.4 file with a correct cross-reference table unless it is
 * deliberately broken.
 */

function buildPdf(objects: Array<string | Buffer>, trailerExtra = ''): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'), Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

const stream = (content: string, dict = '') => `<< /Length ${Buffer.byteLength(content, 'latin1')} ${dict}>>\nstream\n${content}\nendstream`;
const pdfString = (s: string) => `(${s.replace(/[\\()]/g, c => `\\${c}`)})`;

/** One page per entry; each page shows its lines in Helvetica. */
export function textPdf(pages: string[][], trailerExtra = '', extraObjects: string[] = []): Buffer {
  // Objects: 1 catalog, 2 pages, 3 font, then (page, content) per page, then extras.
  const pageIds = pages.map((_, i) => 4 + i * 2);
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  pages.forEach((lines, i) => {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[i] + 1} 0 R >>`);
    objects.push(stream(`BT /F1 11 Tf 14 TL 72 740 Td ${lines.map(l => `${pdfString(l)} Tj T*`).join(' ')} ET`));
  });
  return buildPdf([...objects, ...extraObjects], trailerExtra);
}

/** A "scanned" CV: one page that only draws an image, with no text at all. */
export function imageOnlyPdf(): Buffer {
  const pixels = Buffer.alloc(16 * 16, 0x80).toString('latin1');
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
    stream('q 400 0 0 500 100 150 cm /Im1 Do Q'),
    stream(pixels, '/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 '),
  ]);
}

// ── Standard security handler, revision 2 (40-bit RC4), as in the PDF spec ──
const PASSWORD_PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');
const md5 = (...parts: Buffer[]) => createHash('md5').update(Buffer.concat(parts)).digest();
const pad = (password: string) => Buffer.concat([Buffer.from(password, 'latin1'), PASSWORD_PAD]).subarray(0, 32);

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

/**
 * An encrypted text PDF. With a user password it cannot be opened without
 * it ("password-protected"); with an empty one it opens but is still
 * encrypted (owner restrictions only). Its streams are not encrypted, which
 * is fine: both tests stop before page content is read.
 */
export function encryptedPdf(userPassword: string): Buffer {
  const id = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const permissions = -44;
  const o = rc4(md5(pad('owner-secret')).subarray(0, 5), pad(userPassword));
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  const u = rc4(md5(pad(userPassword), o, p, id).subarray(0, 5), PASSWORD_PAD);
  const encryptObjectId = 6; // after catalog, pages, font, page, content
  return textPdf(
    [['Encrypted CV - Back-End Developer, Node.js.']],
    `/Encrypt ${encryptObjectId} 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] `,
    [`<< /Filter /Standard /V 1 /R 2 /O <${o.toString('hex')}> /U <${u.toString('hex')}> /P ${permissions} >>`]
  );
}

/** Starts like a PDF but is not one. */
export function corruptedPdf(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 37 + 11) % 256))]);
}

export const toBase64 = (buffer: Buffer) => buffer.toString('base64');
