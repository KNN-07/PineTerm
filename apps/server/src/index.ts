import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { ConfigurationError, loadConfig } from './config.js';

async function start(): Promise<void> {
  let sourceRevision = process.env.PINETERM_SOURCE_REVISION;
  if (!sourceRevision) {
    try {
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
      }).trim();
      if (/^[a-f0-9]{40}$/.test(revision)) sourceRevision = revision;
    } catch {
      // Source archives without Git use the optional explicit deployment revision.
    }
  }
  const config = loadConfig({ ...process.env, PINETERM_SOURCE_REVISION: sourceRevision });
  const app = await buildApp({ config });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().then(() => process.exit(0), () => {
        console.error('PineTerm could not shut down cleanly.');
        process.exit(1);
      });
    });
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

start().catch((error: unknown) => {
  if (error instanceof ConfigurationError) console.error(`PineTerm configuration: ${error.message}`);
  else if (error instanceof Error && error.message === 'Production web assets are missing. Run npm run build before npm start.') console.error(error.message);
  else if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') console.error('PineTerm listen address is already in use. Set PINETERM_PORT to a free port; development proxy follows that setting.');
  else console.error('PineTerm failed to start. Check data-directory permissions, installed dependencies and the listen address.');
  process.exitCode = 1;
});
