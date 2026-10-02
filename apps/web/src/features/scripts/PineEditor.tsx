import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';

const theme = EditorView.theme({
  '&': { height: '100%', color: '#E6EDF7', backgroundColor: '#0B1018' },
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace', fontSize: '12px', overflow: 'auto' },
  '.cm-content': { caretColor: '#2DD4BF', minHeight: '120px' },
  '.cm-gutters': { backgroundColor: '#131B27', color: '#A1AFC4', borderColor: '#253247' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#182233' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#253247' },
  '.cm-panels': { backgroundColor: '#131B27', color: '#E6EDF7' },
}, { dark: true });

/** Plain Pine text editing/search, not a pretend complete Pine language server. */
export function PineEditor({ source, documentKey, readOnly, onChange }: { source: string; documentKey: string; readOnly: boolean; onChange: (source: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const editing = useRef(new Compartment());
  const initial = useRef(source); initial.current = source;
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial.current, extensions: [basicSetup, theme, editing.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), EditorView.contentAttributes.of({ 'aria-label': 'Pine source editor' }), EditorView.updateListener.of((update) => { if (update.docChanged) change.current(update.state.doc.toString()); })] }) });
    view.current = editor;
    return () => { view.current = null; editor.destroy(); };
  }, [documentKey]);
  useEffect(() => {
    const editor = view.current;
    if (editor && source !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
  }, [source]);
  useEffect(() => {
    view.current?.dispatch({ effects: editing.current.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) });
  }, [readOnly]);
  return <div className="pine-code" ref={host} />;
}
