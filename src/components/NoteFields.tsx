import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import { ImagePlus, Brackets, ClipboardPaste } from 'lucide-react';
import { imageFilesFrom, storeImage } from '../lib/media';
import { nextClozeIndex, wrapInCloze } from '../lib/cloze';
import type { NoteType } from '../types';
import { FieldContent } from './FieldContent';
import { renderClozeFront } from '../lib/cloze';
import { useToast } from './ui';

// ---------------------------------------------------------------------------
// Paste routing: a Ctrl+V often lands with focus on a button or the page body,
// not inside a field textarea — the paste event then never reaches the field.
// One document-level listener routes image pastes to the most recently focused
// FieldEditor (falling back to the first mounted one, i.e. the Front field).
type PasteSink = { insertFiles: (files: File[]) => void };
const sinks = new Set<PasteSink>();
let activeSink: PasteSink | null = null;
let docPasteHandler: ((e: globalThis.ClipboardEvent) => void) | null = null;

function syncDocPasteListener() {
  if (sinks.size > 0 && !docPasteHandler) {
    docPasteHandler = (e) => {
      if (e.defaultPrevented) return; // a field textarea already handled it
      const files = imageFilesFrom(e.clipboardData);
      if (files.length === 0) return; // plain text pastes stay untouched
      const sink = activeSink ?? sinks.values().next().value;
      if (!sink) return;
      e.preventDefault();
      sink.insertFiles(files);
    };
    document.addEventListener('paste', docPasteHandler);
  } else if (sinks.size === 0 && docPasteHandler) {
    document.removeEventListener('paste', docPasteHandler);
    docPasteHandler = null;
  }
}
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  clozeButton?: boolean;
  autoFocus?: boolean;
}

export function FieldEditor({ label, value, onChange, placeholder, clozeButton, autoFocus }: FieldEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);

  // Latest value/onChange for async handlers (image storage awaits between
  // insertions — a closure over render-time props would clobber edits).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const insertAtCursor = (snippet: string) => {
    const ta = ref.current;
    const current = valueRef.current;
    if (!ta) {
      onChangeRef.current(current + snippet);
      return;
    }
    const start = ta.selectionStart ?? current.length;
    const end = ta.selectionEnd ?? current.length;
    const next = current.slice(0, start) + snippet + current.slice(end);
    onChangeRef.current(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + snippet.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const handleImages = async (files: File[]) => {
    const tokens: string[] = [];
    for (const file of files) {
      try {
        tokens.push(`[img:${await storeImage(file)}]`);
      } catch {
        toast.push('error', 'Could not store the image.');
      }
    }
    if (tokens.length > 0) insertAtCursor(`\n${tokens.join('\n')}\n`);
  };
  const handleImagesRef = useRef(handleImages);
  handleImagesRef.current = handleImages;

  // Register with the document-level paste router.
  useEffect(() => {
    const sink: PasteSink = { insertFiles: (files) => void handleImagesRef.current(files) };
    sinks.add(sink);
    syncDocPasteListener();
    const ta = ref.current;
    const markActive = () => {
      activeSink = sink;
    };
    ta?.addEventListener('focus', markActive);
    if (ta && document.activeElement === ta) markActive(); // autoFocus fired before this effect
    return () => {
      ta?.removeEventListener('focus', markActive);
      sinks.delete(sink);
      if (activeSink === sink) activeSink = null;
      syncDocPasteListener();
    };
  }, []);

  const onPaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      void handleImages(files);
    }
  };

  const onDrop = (e: ReactDragEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFrom(e.dataTransfer);
    setDragOver(false);
    if (files.length > 0) {
      e.preventDefault();
      void handleImages(files);
    }
  };

  // Escape hatch when the paste event route fails (some Linux clipboard
  // managers / copied-file clipboards): read the image via the async
  // Clipboard API on explicit request.
  const pasteFromClipboard = async () => {
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await item.getType(type);
          files.push(new File([blob], 'clipboard-image', { type }));
        }
      }
      if (files.length === 0) {
        toast.push(
          'error',
          'No image in the clipboard. If you copied a file in your file manager, drag it into the field instead.',
        );
        return;
      }
      await handleImages(files);
    } catch {
      toast.push('error', 'Clipboard read was blocked — allow clipboard access for this site, or use the attach button.');
    }
  };

  const addCloze = () => {
    const ta = ref.current;
    const start = ta?.selectionStart ?? value.length;
    const end = ta?.selectionEnd ?? value.length;
    const idx = nextClozeIndex(value);
    const { text, caret } = wrapInCloze(value, start, end, idx);
    onChange(text);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(start === end ? caret : caret, caret);
    });
  };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = () => {
      if (input.files) void handleImages(Array.from(input.files));
    };
    input.click();
  };

  return (
    <div className="field-editor">
      <div className="field-editor-head">
        <label className="field-label">{label}</label>
        <div className="field-tools">
          {clozeButton && (
            <button
              type="button"
              className="icon-btn"
              title="Wrap selection in a cloze deletion (Ctrl+Shift+C)"
              aria-label="Add cloze deletion"
              onClick={addCloze}
            >
              <Brackets size={16} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn"
            title="Paste image from clipboard"
            aria-label="Paste image from clipboard"
            onClick={() => void pasteFromClipboard()}
          >
            <ClipboardPaste size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Attach image (or just paste a screenshot)"
            aria-label="Attach image"
            onClick={pickFile}
          >
            <ImagePlus size={16} />
          </button>
        </div>
      </div>
      <textarea
        ref={ref}
        className={`textarea ${dragOver ? 'drag-over' : ''}`}
        value={value}
        placeholder={placeholder ?? 'Type here — paste screenshots directly'}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onKeyDown={(e) => {
          if (clozeButton && e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
            e.preventDefault();
            addCloze();
          }
        }}
        rows={3}
        autoFocus={autoFocus}
      />
      {/\[img:/.test(value) && (
        <div className="field-preview">
          <FieldContent text={value} />
        </div>
      )}
    </div>
  );
}

export function notePreview(type: NoteType, front: string): string {
  if (type === 'cloze') return renderClozeFront(front, 1);
  return front;
}
