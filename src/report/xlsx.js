import ExcelJS from 'exceljs';
import { getCanonical, getLocations } from '../db.js';
import { displayCanonical } from '../compare/classify.js';
import { buildListings, CORRECT, FIX, WRONG_LOCATION, CHECK, STATUS_ORDER } from './listings.js';

const FILL = { [CORRECT]: 'FFD9EAD3', [FIX]: 'FFFCE5CD', [WRONG_LOCATION]: 'FFF4CCCC', [CHECK]: 'FFFFF2CC' };
const HEADER = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } } };
const WRAP = { vertical: 'top', wrapText: true };

function table(ws, header, rows, widths, { statusCol, linkCol = 2 } = {}) {
  ws.columns = header.map((h, i) => ({ header: h, width: widths[i] }));
  ws.getRow(1).eachCell(c => { c.font = HEADER.font; c.fill = HEADER.fill; c.alignment = { vertical: 'middle', wrapText: true }; });
  for (const r of rows) {
    const row = ws.addRow(r);
    row.eachCell({ includeEmpty: true }, c => { c.alignment = WRAP; });
    const link = row.getCell(linkCol);
    if (/^https?:\/\//.test(link.value || '')) { link.value = { text: link.value, hyperlink: link.value }; link.font = { color: { argb: 'FF1155CC' }, underline: true }; }
    if (statusCol) { const s = row.getCell(statusCol); if (FILL[s.value]) s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[s.value] } }; }
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
}

// The client deliverable. Same three tabs, statuses and colors on every run.
export async function buildWorkbook(run, client) {
  const { listings, mentions, findings } = buildListings(run, client);
  const canonical = getCanonical(client.id);
  const locations = getLocations(client);
  const name = displayCanonical('name', canonical.name?.value) || client.name;
  const addr = displayCanonical('address', canonical.address?.value);
  const phone = displayCanonical('phone', canonical.phone?.value);
  const website = displayCanonical('website', canonical.website?.value) || client.website || '';

  const gbpRows = [];
  if (client.gbp_url || canonical.address) gbpRows.push({ site: 'Google Business Profile (main location)', url: client.gbp_url || '', status: CORRECT, name, address: addr, phone, notes: 'Source of truth for every other listing.' });
  for (const loc of locations.addresses) gbpRows.push({ site: `Other location: ${loc}`, url: '', status: CORRECT, name, address: loc, phone, notes: 'Listings for this location count as correct.' });
  const all = [...gbpRows, ...listings];
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, all.filter(l => l.status === s).length]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Citation Audit';
  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 40 }, { width: 110 }];
  const line = (a, b = '', bold = false) => { const r = s.addRow([a, b]); r.eachCell({ includeEmpty: true }, c => { c.alignment = WRAP; }); if (bold) r.getCell(1).font = { bold: true }; return r; };
  s.addRow([`${name}: Citation Audit`]).getCell(1).font = { bold: true, size: 14 };
  line('Audit date', run.started_at.slice(0, 10));
  line('');
  line('Correct business info (source of truth)', '', true);
  line('Name', name); line('Address', addr); line('Phone', phone); line('Website', website);
  for (const loc of locations.addresses) line('Other location', loc);
  for (const p of locations.phones) line('Other phone', p);
  line('');
  line('Results', '', true);
  line('Listings found', all.length);
  for (const st of [CORRECT, FIX, WRONG_LOCATION, CHECK]) { const r = line(st, counts[st]); r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[st] } }; }
  line('Web mentions (not listings)', mentions.length);
  if (findings.length) {
    line('');
    line('Key findings', '', true);
    findings.forEach((f, i) => line(String(i + 1), f));
  }

  table(wb.addWorksheet('Full Citation List'), ['Directory', 'Profile URL', 'Status', 'Name Shown', 'Address Shown', 'Phone Shown', 'What To Fix / Notes'],
    all.map(l => [l.site, l.url, l.status, l.name, l.address, l.phone, l.notes]), [34, 60, 22, 30, 38, 18, 70], { statusCol: 3 });
  table(wb.addWorksheet('Web Mentions'), ['Site', 'Page URL', 'What It Is'], mentions.map(m => [m.site, m.url, m.what]), [36, 70, 80]);
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), counts, total: all.length };
}

export const xlsxName = (client, run) => `${(client.name || client.slug).replace(/[^\w-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')}-Citation-List-${run.started_at.slice(0, 10)}.xlsx`;
