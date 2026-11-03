import { reportNarratives } from './db.js';

const narratives = await reportNarratives('Papua', 2025, 9);
console.log('narratives count:', narratives.length);
console.log(narratives.map(r => ({ jenis: r.jenis_akomodasi, ind: r.indicator, hasNarrative: !!r.narrative })));

const narrativeBy = new Map(narratives.map((r) => [`${r.jenis_akomodasi}|${r.indicator}`, r.narrative]));
console.log('wisman|wisman:', narrativeBy.get('wisman|wisman') ? 'FOUND' : 'NOT FOUND');

process.exit(0);
