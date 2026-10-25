import { MossClient } from '@moss-js/moss';
const c = new MossClient(process.env.MOSS_PROJECT_ID!, process.env.MOSS_PROJECT_KEY!);
const names = (await c.listIndexes()).map((i: { name?: string } | string) => (typeof i === 'string' ? i : i.name));
console.log('before', names);
if (names.includes('ahead-memory')) { await c.deleteIndex('ahead-memory'); console.log('deleted ahead-memory'); }
await c.close();
