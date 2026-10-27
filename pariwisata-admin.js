import { MONTH_NAMES, sortPeriods, uniqueSorted } from './lib.js';
import { pariwisataInfo } from './db.js';
import {
  countFiltered, countExistingPeriods, periodRows, rowsToTsv, seriesData,
} from './etl-pariwisata.js';

export const PARIWISATA_PROVINCES = ['Papua', 'Papua Selatan', 'Papua Tengah', 'Papua Pegunungan'];
export const PARIWISATA_VARS = ['tpk', 'rlmtgab', 'mktj', 'mkts', 'mtgab'];

// Section ids double as deep-link anchors (?sub=upload) and <details> ids.
export const PARIWISATA_SECTIONS = ['upload', 'edit', 'delete', 'series'];

const MONTH_INDEX = Object.fromEntries(MONTH_NAMES.map((m, i) => [m, i + 1]));
const MONTH_BY_INDEX = Object.fromEntries(MONTH_NAMES.map((m, i) => [m, i + 1]));

/**
 * Build every admin section in one pass so the page needs no second-level tabs.
 * `focus` only decides which <details> starts expanded and where to scroll.
 */
export async function buildPariwisataAdmin(session, url, { uploads, readFlash }) {
  const requested = url.searchParams.get('sub');
  const focus = PARIWISATA_SECTIONS.includes(requested) ? requested : 'upload';
  const message = readFlash(url);
  const admin = { focus };

  const infoRows = await pariwisataInfo();
  const periods = sortPeriods(infoRows.map((r) => ({ tahun: r.year, bulan: MONTH_BY_INDEX[r.month] })));
  const years = uniqueSorted(infoRows.map((r) => r.year));
  const latest = periods.at(-1);

  // ---- upload -------------------------------------------------------------
  const stage = url.searchParams.get('stage');
  const record = stage ? uploads.get(stage) : null;
  admin.upload = {
    stage: record ? stage : null,
    files: record
      ? record.files.map((f) => ({ nama_file: f.nama_file, tahun: f.tahun, bulan: f.bulan }))
      : [],
    preview: record && url.searchParams.get('preview') === '1' ? record.preview : null,
    message,
    defaultYear: latest?.thn ?? new Date().getFullYear(),
    defaultMonth: latest?.bln ?? MONTH_NAMES[0],
  };

  // ---- manual correction --------------------------------------------------
  const editTahun = Number(url.searchParams.get('tahun')) || latest?.thn || new Date().getFullYear();
  const editBulanName = MONTH_NAMES.includes(url.searchParams.get('bulan'))
    ? url.searchParams.get('bulan')
    : (latest?.bln ?? MONTH_NAMES[0]);
  let tsv = null;
  if (url.searchParams.get('load') === '1') {
    const rows = await periodRows(editTahun, MONTH_INDEX[editBulanName]);
    tsv = rows.length ? rowsToTsv(rows) : '';
  }
  admin.edit = {
    tahun: editTahun,
    bulan: editBulanName,
    tsv,
    years,
    message,
  };

  // ---- delete by filter ---------------------------------------------------
  const delProvince = url.searchParams.get('province') || 'SEMUA';
  const delYear = url.searchParams.get('year') || 'SEMUA';
  const delMonth = url.searchParams.get('month') || 'SEMUA';
  const delCount = url.searchParams.get('count') === '1'
    ? await countFiltered({
      provinsi: delProvince,
      tahun: delYear,
      bulan: delMonth === 'SEMUA' ? 'SEMUA' : MONTH_INDEX[delMonth],
    })
    : null;
  admin.del = {
    province: delProvince,
    tahun: delYear,
    bulan: delMonth,
    years,
    provinces: PARIWISATA_PROVINCES,
    count: delCount,
    message,
  };

  // ---- series -------------------------------------------------------------
  const seriesProv = PARIWISATA_PROVINCES.includes(url.searchParams.get('provinsi'))
    ? url.searchParams.get('provinsi')
    : 'SEMUA';
  const selectedVars = url.searchParams.getAll('variabel').filter((v) => PARIWISATA_VARS.includes(v));
  admin.seriesForm = {
    provinsi: seriesProv,
    provinces: PARIWISATA_PROVINCES,
    variabel: {
      options: PARIWISATA_VARS,
      selected: selectedVars.length ? selectedVars : ['tpk', 'rlmtgab'],
    },
    series: await seriesData({
      provinsi: seriesProv,
      kabupaten: 'SEMUA',
      variabel: selectedVars.length ? selectedVars : ['tpk', 'rlmtgab'],
    }),
  };

  return admin;
}

export { countExistingPeriods };
