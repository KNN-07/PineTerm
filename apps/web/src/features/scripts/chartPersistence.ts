import { registerStatePersistence } from '@luxalgo/vela/widget';
import { pineSourceVersion, type PineValue } from '@pineterm/contracts';

const prefix = 'pineterm:';
interface PreviewSnapshot { id: string; source: string; title: string; inputs: Record<string, PineValue>; props: Record<string, PineValue>; hidden: boolean; overlay: boolean }
function values(value: unknown): value is Record<string, PineValue> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, entry]) => !['__proto__', 'constructor', 'prototype'].includes(key) && (typeof entry === 'string' || typeof entry === 'boolean' || (typeof entry === 'number' && Number.isFinite(entry))));
}

// Raw editor runs aren't manifest instances. Vela's public ext seam owns their reload/layout lifecycle.
registerStatePersistence({
  key: 'pineterm.pinePreviews', scope: 'cell',
  serialize({ chart }) {
    const price = chart.panes.list().find((pane) => pane.kind === 'price');
    return chart.indicators().filter((handle) => handle.id.startsWith(prefix) && handle.source).map((handle): PreviewSnapshot => ({ id: handle.id, source: handle.source!, title: handle.title, inputs: handle.inputValues(), props: handle.propValues(), hidden: !handle.visible, overlay: !!price?.indicators.some((indicator) => indicator.id === handle.id) }));
  },
  restore(payload, { chart }) {
    if (!Array.isArray(payload) || payload.length > 100) throw new Error('Invalid saved Pine preview list. Download the workspace state before editing it.');
    const snapshots: PreviewSnapshot[] = [];
    for (const entry of payload as unknown[]) {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid saved Pine preview.');
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== 'string' || !item.id.startsWith(prefix) || typeof item.title !== 'string' || typeof item.source !== 'string' || new TextEncoder().encode(item.source).length > 262144 || pineSourceVersion(item.source) === null || !values(item.inputs) || !values(item.props) || typeof item.hidden !== 'boolean' || typeof item.overlay !== 'boolean') throw new Error('Invalid saved Pine preview.');
      snapshots.push(item as unknown as PreviewSnapshot);
    }
    const wanted = new Set(snapshots.map((item) => item.id));
    for (const handle of chart.indicators()) if (handle.id.startsWith(prefix) && !wanted.has(handle.id)) handle.remove();
    for (const item of snapshots) {
      const present = chart.indicators().find((handle) => handle.id === item.id);
      if (present) {
        if (present.source !== item.source) present.updateCode(item.source);
        if (JSON.stringify(present.inputValues()) !== JSON.stringify(item.inputs)) present.setInputs(item.inputs);
        if (JSON.stringify(present.propValues()) !== JSON.stringify(item.props)) present.setProps(item.props);
        present.setVisible(!item.hidden);
        const overlay = chart.panes.list().some((pane) => pane.kind === 'price' && pane.indicators.some((indicator) => indicator.id === item.id));
        if (overlay !== item.overlay) present.moveTo(item.overlay ? 'price' : { newPane: true });
      }
      else {
        const handle = chart.addIndicator(item.source, { id: item.id, title: item.title, inputs: item.inputs, props: item.props, overlay: item.overlay });
        if (item.hidden) handle.setVisible(false);
      }
    }
  },
});
