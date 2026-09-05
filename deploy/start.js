import {startWebServer} from '../src/server.js';

if (!process.env.OPENPPT_PUBLIC_ORIGIN) {
  throw new Error('OPENPPT_PUBLIC_ORIGIN is required for the container listener');
}
const ctx = startWebServer({
  hostname: '0.0.0.0',
  port: 7357,
  publicOrigin: process.env.OPENPPT_PUBLIC_ORIGIN,
  dataDir: '/data/projects',
});
console.log(`OpenPPT Studio: ${ctx.url}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {ctx.stop(); process.exit(0);});
}
