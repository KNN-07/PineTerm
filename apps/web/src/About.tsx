import { useEffect, useState } from 'react';
import type { ApiMetadata } from '@pineterm/contracts';
import { ApiClient, errorMessage } from './api.js';
import { Modal } from './Modal.js';

export const SOURCE_URL = 'https://github.com/KNN-07/PineTerm';

export function About({ client, onClose }: { client: ApiClient; onClose: () => void }) {
  const [metadata, setMetadata] = useState<ApiMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadVersion, setLoadVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    client.getMetadata(controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setMetadata(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, loadVersion]);

  const revisionUrl = metadata?.sourceRevision
    ? `${SOURCE_URL}/tree/${encodeURIComponent(metadata.sourceRevision)}`
    : SOURCE_URL;

  return (
    <Modal title="About PineTerm" titleId="about-title" onClose={onClose}>
      <p className="about-tagline">Your self-hosted charting and strategy workspace.</p>
      <p>PineTerm is an original, single-user application. Administrator sessions, scoped API keys, fixed-venue crypto data and historical CSV services are available. Chart UI, durable Pine execution, trading, alerts and agent analysis are not implemented yet.</p>
      <section aria-labelledby="source-title">
        <h3 id="source-title">License and source</h3>
        <p>Original PineTerm code is licensed <strong>AGPL-3.0-only</strong>. Corresponding source is available on <a href={revisionUrl} target="_blank" rel="noopener noreferrer">GitHub{metadata?.sourceRevision ? ' at the deployed revision' : ''}</a>.</p>
        {loading && <p role="status">Loading deployment metadata…</p>}
        {error && (
          <div className="message error" role="alert">
            <p>Deployment metadata is unavailable: {error}</p>
            <button type="button" disabled={loading} onClick={() => setLoadVersion((value) => value + 1)}>Retry metadata</button>
          </div>
        )}
        {metadata && (
          <dl className="key-details">
            <div><dt>Version</dt><dd>{metadata.version}</dd></div>
            <div><dt>Milestone</dt><dd>{metadata.milestone}</dd></div>
            <div><dt>Source revision</dt><dd>{metadata.sourceRevision ? <code>{metadata.sourceRevision}</code> : 'Not supplied by this deployment'}</dd></div>
          </dl>
        )}
      </section>
      <section aria-labelledby="attribution-title">
        <h3 id="attribution-title">Open-source attribution</h3>
        <p>The planned chart workspace is powered by <a href="https://velacharts.dev" target="_blank" rel="noopener noreferrer">Vela by LuxAlgo</a> (Apache-2.0). Vela is not mounted in this milestone. PineTS and the Vela PineTS integration are AGPL-3.0; their execution features arrive in a later milestone.</p>
        <p>Third-party license and notice files remain applicable. PineTerm is not affiliated with TradingView and does not claim feature or simulation parity.</p>
      </section>
      <section aria-labelledby="limits-title">
        <h3 id="limits-title">Data and execution boundaries</h3>
        <p>No market prices, strategy results or portfolio gains are seeded here. Future PineTS results will be simulations, not promises of profit or TradingView-identical execution. Live executor handoff is not available or enabled.</p>
      </section>
    </Modal>
  );
}
