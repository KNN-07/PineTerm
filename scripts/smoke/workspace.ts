import assert from 'node:assert/strict';
import type { Workspace, Watchlist } from '../../packages/contracts/src/workspace.js';

export async function runWorkspaceScenario(url: string, headers: Record<string, string>): Promise<void> {
  const velaState = { version: 1, layout: '1', charts: [{ id: 'primary', symbol: 'COINBASE:BTC-USD', timeframe: '60', priceStyle: 'candles' }], ext: { 'pineterm.smoke': { preserved: true } } };
  const created = await fetch(url + '/api/v1/workspaces', { method: 'POST', headers, body: JSON.stringify({ name: 'HTTP persistence smoke', velaState, uiState: { bottomHeight: 260 } }) });
  assert.equal(created.status, 201, await created.clone().text());
  const { workspace } = await created.json() as { workspace: Workspace };
  const update = { name: workspace.name, revision: workspace.revision, velaState: { ...velaState, layout: '4' }, uiState: { bottomHeight: 300 } };
  const saved = await fetch(url + '/api/v1/workspaces/' + workspace.id, { method: 'PUT', headers, body: JSON.stringify(update) });
  assert.equal(saved.status, 200, await saved.clone().text());
  const accepted = await saved.json() as { workspace: Workspace };
  assert.equal(accepted.workspace.revision, workspace.revision + 1);
  assert.equal((await fetch(url + '/api/v1/workspaces/' + workspace.id, { method: 'PUT', headers, body: JSON.stringify(update) })).status, 409);
  const restored = await (await fetch(url + '/api/v1/workspaces/' + workspace.id, { headers })).json() as { workspace: Workspace };
  assert.deepEqual(restored.workspace, accepted.workspace);

  const items = [{ provider: 'coinbase', symbol: 'BTC-USD' }, { provider: 'binance', symbol: 'BTCUSDT' }];
  const listResponse = await fetch(url + '/api/v1/watchlists', { method: 'POST', headers, body: JSON.stringify({ name: 'Venue distinction', items }) });
  assert.equal(listResponse.status, 201, await listResponse.clone().text());
  const { watchlist } = await listResponse.json() as { watchlist: Watchlist };
  const reordered = await fetch(url + '/api/v1/watchlists/' + watchlist.id, { method: 'PUT', headers, body: JSON.stringify({ name: watchlist.name, revision: watchlist.revision, items: [...items].reverse() }) });
  assert.equal(reordered.status, 200, await reordered.clone().text());
  assert.deepEqual((await reordered.json() as { watchlist: Watchlist }).watchlist.items, [...items].reverse());
  console.log('workspace: real HTTP state saved, restored with version/ext fields, stale revision rejected; qualified venue list reordered atomically');
  const { 'Content-Type': _contentType, ...deleteHeaders } = headers;
  assert.equal((await fetch(url + '/api/v1/workspaces/' + workspace.id, { method: 'DELETE', headers: deleteHeaders })).status, 204);
  assert.equal((await fetch(url + '/api/v1/watchlists/' + watchlist.id, { method: 'DELETE', headers: deleteHeaders })).status, 204);
}
