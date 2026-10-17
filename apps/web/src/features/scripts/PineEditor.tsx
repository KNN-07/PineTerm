import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';

const theme = EditorView.theme({
  '&': { height: '100%', color: '#D1D4DC', backgroundColor: '#131722' },
  '.cm-scroller': { fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", ui-monospace, monospace', fontSize: '13px', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: '#D1D4DC', minHeight: '120px' },
  '.cm-cursor': { borderLeftColor: '#D1D4DC' },
  '.cm-gutters': { backgroundColor: '#131722', color: '#50535E', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#B2B5BE' },
  '.cm-activeLine': { backgroundColor: 'rgba(42, 46, 57, 0.45)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(41, 98, 255, 0.32) !important' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(41, 98, 255, 0.25)', outline: 'none' },
  '.cm-panels': { backgroundColor: '#1E222D', color: '#D1D4DC' },
  '.cm-panels input, .cm-panels button': { minHeight: '26px' },
  '.cm-tooltip': { backgroundColor: '#1E222D', border: '1px solid #363A45' },
}, { dark: true });

const KEYWORDS = new Set(['if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'var', 'varip', 'import', 'export', 'method', 'type', 'enum', 'and', 'or', 'not', 'break', 'continue', 'return']);
const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'array', 'matrix', 'map', 'series', 'simple', 'const', 'input', 'polyline', 'linefill', 'chart']);
const ATOMS = new Set(['true', 'false', 'na']);
const DECLARATIONS = new Set(['indicator', 'strategy', 'library']);

/** A small Pine Script tokenizer for colouring only — compilation stays with the isolated runner. */
const pine = StreamLanguage.define<{ annotation: boolean }>({
  name: 'pine',
  startState: () => ({ annotation: false }),
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\/\/@\w+/)) return 'meta';
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^#[0-9a-fA-F]{6,8}\b/)) return 'atom';
    if (stream.match(/^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/) || stream.match(/^\.\d+/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/)) {
      const word = stream.current();
      if (KEYWORDS.has(word)) return 'keyword';
      if (ATOMS.has(word)) return 'atom';
      if (TYPES.has(word)) return 'typeName';
      if (DECLARATIONS.has(word)) return 'definitionKeyword';
      if (stream.peek() === '(') return 'function';
      if (word.includes('.')) return 'namespace';
      return 'variableName';
    }
    if (stream.match(/^(?::=|=>|==|!=|<=|>=|\+=|-=|\*=|\/=|[-+*/%=<>?:])/)) return 'operator';
    stream.next();
    return null;
  },
  tokenTable: { function: tags.function(tags.variableName), namespace: tags.namespace, definitionKeyword: tags.definitionKeyword },
});

const pineColours = HighlightStyle.define([
  { tag: tags.comment, color: '#787B86', fontStyle: 'italic' },
  { tag: tags.meta, color: '#787B86' },
  { tag: [tags.keyword, tags.definitionKeyword], color: '#F7525F' },
  { tag: tags.typeName, color: '#2EBD85' },
  { tag: tags.string, color: '#7FD18B' },
  { tag: [tags.number, tags.atom], color: '#FF9800' },
  { tag: tags.function(tags.variableName), color: '#5B9CF6' },
  { tag: tags.namespace, color: '#9C6ADE' },
  { tag: tags.operator, color: '#B2B5BE' },
  { tag: tags.variableName, color: '#D1D4DC' },
]);

/** Plain Pine text editing/search, not a pretend complete Pine language server. */
export function PineEditor({ source, documentKey, readOnly, onChange }: { source: string; documentKey: string; readOnly: boolean; onChange: (source: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange); change.current = onChange;
  const editing = useRef(new Compartment());
  const initial = useRef(source); initial.current = source;
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial.current, extensions: [basicSetup, theme, pine, syntaxHighlighting(pineColours), editing.current.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]), EditorView.contentAttributes.of({ 'aria-label': 'Pine source editor' }), EditorView.updateListener.of((update) => { if (update.docChanged) change.current(update.state.doc.toString()); })] }) });
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
