import { createApp } from './app.js';

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';
const app = await createApp({ log: process.env.LOG === '1' ? console.log : () => {} });
if (app.bootstrapPassword) {
  console.log(`First run: created user "owner" with password "${app.bootstrapPassword}". Change it after logging in.`);
}
app.server.listen(port, host, () => console.log(`SK Keong pricing app listening on http://${host}:${port}`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { app.close(); process.exit(0); });
