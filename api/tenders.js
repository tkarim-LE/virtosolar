// One function serves every client tool. The Vercel project's TOOL env var picks the client.
import { put, head } from '@vercel/blob';
import { makeHandler, makeStore } from '../lib/serve.js';
import virto from '../clients/virto/feed.js';
import installer from '../clients/installer/feed.js';

export const maxDuration = 60;

const clients = { virto, installer };
const client = clients[process.env.TOOL || (process.env.VERCEL ? '' : 'virto')];
if (!client) throw new Error(`Unknown TOOL "${process.env.TOOL}"`);

export const GET = makeHandler({ client, store: makeStore({ put, head }) });
