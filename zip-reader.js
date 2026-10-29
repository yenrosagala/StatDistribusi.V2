// Pembaca arsip ZIP minimal, memakai zlib bawaan Node.
//
// Dipakai untuk mengambil berkas DBF dari ZIP yang diunggah admin. Tidak
// memakai dependensi eksternal karena modul native sulit dipasang di server
// tanpa registry. Mendukung metode "stored" (0) dan "deflate" (8), termasuk
// data descriptor -- yang dipakai sebagian besar alat pembuat ZIP.
import zlib from 'node:zlib';

const SIG_EOCD = 0x06054b50;      // End of central directory
const SIG_CEN = 0x02014b50;       // Central directory file header
const SIG_LOC = 0x04034b50;       // Local file header

function findEocd(buffer) {
  // EOCD berada di 22 byte terakhir, tapi bisa diikuti komentar (maks 65535).
  const min = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Baca seluruh entri ZIP.
 * @returns {{name: string, buffer: Buffer}[]}
 */
export function readZip(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('Bukan berkas ZIP yang valid (central directory tidak ditemukan).');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== SIG_CEN) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compSize = buffer.readUInt32LE(offset + 20);
    const uncompSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // direktori

    // Panjang nama/extra di header lokal bisa berbeda dari central directory.
    if (buffer.readUInt32LE(localOffset) !== SIG_LOC) continue;
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    // compSize bisa 0 bila ZIP memakai data descriptor; dalam kasus itu pakai
    // batas berikutnya (ukuran lokal tidak tersedia) -> ambil sepanjang yang ada.
    let end = compSize > 0 ? dataStart + compSize : dataStart + uncompSize;
    if (end > buffer.length) end = buffer.length;
    const raw = buffer.subarray(dataStart, end);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Metode kompresi ZIP ${method} tidak didukung (${name}).`);

    entries.push({ name, buffer: data });
  }
  return entries;
}
