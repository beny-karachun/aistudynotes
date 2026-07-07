import { useEffect, useState, type ReactNode } from 'react';
import { mediaUrl } from '../lib/media';
import { splitMath, loadTexRenderer, type TexRender } from '../lib/mathtex';

function MediaImage({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    mediaUrl(id).then((u) => {
      if (!alive) return;
      if (u) setUrl(u);
      else setMissing(true);
    });
    return () => {
      alive = false;
    };
  }, [id]);

  if (missing) return <span className="media-missing">[missing image]</span>;
  if (!url) return <span className="media-loading" aria-hidden="true" />;
  return <img src={url} alt="" className="field-image" loading="lazy" />;
}

// Once the lazy MathJax engine has loaded, rendering becomes synchronous, so
// cards after the first math card never flash raw TeX.
let texRender: TexRender | null = null;

function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [, bump] = useState(0);
  useEffect(() => {
    if (texRender) return;
    let alive = true;
    loadTexRenderer()
      .then((r) => {
        texRender = r;
        if (alive) bump((n) => n + 1);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const html = texRender ? texRender(tex, display) : null;
  if (!html) {
    // engine still loading, or the TeX could not be rendered — show the source
    return <span className={`math-raw ${display ? 'math-display' : ''}`}>{display ? `$$${tex}$$` : `$${tex}$`}</span>;
  }
  return (
    <span
      className={display ? 'math math-display' : 'math'}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Inline markdown-lite: **bold**, *italic*, `code`. Returns React nodes (no HTML injection). */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith('**')) nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    else nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = m.index! + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** A run of prose: TeX math segments + newlines + markdown-lite. */
function renderTextRun(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  splitMath(text).forEach((seg, mi) => {
    const key = `${keyPrefix}-m${mi}`;
    if (seg.kind === 'math') {
      out.push(<MathTex key={key} tex={seg.tex} display={seg.display} />);
      return;
    }
    seg.text.split('\n').forEach((line, li) => {
      if (li > 0) out.push(<br key={`${key}-br${li}`} />);
      out.push(...renderInline(line, `${key}-l${li}`));
    });
  });
  return out;
}

/** Math + markdown-lite for plain prose (AI feedback, typed answers) — no image/cloze tokens. */
export function InlineContent({ text }: { text: string }) {
  return <>{renderTextRun(text, 'ic')}</>;
}

/**
 * Renders a note field: [img:id] tokens become images, ⟪CLOZE⟫…⟪/CLOZE⟫
 * markers (from cloze rendering) become highlighted spans, $…$/$$…$$ become
 * MathJax, newlines become line breaks, plus markdown-lite inline formatting.
 */
export function FieldContent({ text }: { text: string }) {
  const segments = text.split(/(\[img:[a-zA-Z0-9-]+\]|⟪CLOZE⟫[\s\S]*?⟪\/CLOZE⟫)/g);
  const out: ReactNode[] = [];
  segments.forEach((seg, si) => {
    if (!seg) return;
    const img = seg.match(/^\[img:([a-zA-Z0-9-]+)\]$/);
    if (img) {
      out.push(<MediaImage key={`img-${si}`} id={img[1]} />);
      return;
    }
    const cloze = seg.match(/^⟪CLOZE⟫([\s\S]*?)⟪\/CLOZE⟫$/);
    if (cloze) {
      // recurse so a revealed {{c1::$x^2$}} still renders its math
      out.push(
        <span key={`cz-${si}`} className="cloze-mark">
          {renderTextRun(cloze[1], `cz-${si}`)}
        </span>,
      );
      return;
    }
    out.push(...renderTextRun(seg, `t-${si}`));
  });
  return <div className="field-content">{out}</div>;
}
