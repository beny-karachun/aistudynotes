// TeX math in note fields: $inline$ and $$display$$, rendered with MathJax
// (SVG output, bundled — no CDN, works offline). The engine is heavy, so it is
// dynamically imported the first time a rendered field actually contains math.

export type MathSeg =
  | { kind: 'text'; text: string }
  | { kind: 'math'; tex: string; display: boolean };

/**
 * Split field text into plain-text and TeX segments. `$$…$$` may span lines;
 * `$…$` must stay on one line. Conservative about money: an inline candidate
 * whose content starts/ends with whitespace or whose closing `$` is followed
 * by a digit stays plain text ("$5 and $10" renders literally). `\$` escapes
 * a literal dollar sign.
 */
export function splitMath(text: string): MathSeg[] {
  if (!text.includes('$')) return [{ kind: 'text', text }];
  const segs: MathSeg[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      segs.push({ kind: 'text', text: plain });
      plain = '';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && text[i + 1] === '$') {
      plain += '$';
      i += 2;
      continue;
    }
    if (ch === '$') {
      if (text[i + 1] === '$') {
        const end = text.indexOf('$$', i + 2);
        const inner = end === -1 ? '' : text.slice(i + 2, end).trim();
        if (inner) {
          flush();
          segs.push({ kind: 'math', tex: inner, display: true });
          i = end + 2;
          continue;
        }
      } else {
        // find a closing $ on the same line, honoring \-escapes
        let j = i + 1;
        while (j < text.length && text[j] !== '\n' && text[j] !== '$') {
          j += text[j] === '\\' ? 2 : 1;
        }
        const inner = text[j] === '$' ? text.slice(i + 1, j) : '';
        if (inner && !/^\s|\s$/.test(inner) && !/^\d/.test(text.slice(j + 1, j + 2))) {
          flush();
          segs.push({ kind: 'math', tex: inner, display: false });
          i = j + 1;
          continue;
        }
      }
    }
    plain += ch;
    i += 1;
  }
  flush();
  return segs;
}

/** Renders a TeX string to MathJax SVG markup ('' if it cannot be rendered). */
export type TexRender = (tex: string, display: boolean) => string;

let enginePromise: Promise<TexRender> | null = null;

export function loadTexRenderer(): Promise<TexRender> {
  enginePromise ??= initEngine();
  return enginePromise;
}

async function initEngine(): Promise<TexRender> {
  // mathjax-full's version.js eval()s require() unless the bundler defines
  // PACKAGE_VERSION — provide it as a global before the modules evaluate.
  (globalThis as Record<string, unknown>).PACKAGE_VERSION ??= '3.2.2';
  const [{ mathjax }, { TeX }, { SVG }, { browserAdaptor }, { RegisterHTMLHandler }, { AllPackages }] =
    await Promise.all([
      import('mathjax-full/js/mathjax.js'),
      import('mathjax-full/js/input/tex.js'),
      import('mathjax-full/js/output/svg.js'),
      import('mathjax-full/js/adaptors/browserAdaptor.js'),
      import('mathjax-full/js/handlers/html.js'),
      import('mathjax-full/js/input/tex/AllPackages.js'),
    ]);
  const adaptor = browserAdaptor();
  RegisterHTMLHandler(adaptor);
  const svg = new SVG<HTMLElement, Text, Document>({ fontCache: 'local' });
  const doc = mathjax.document(document, {
    InputJax: new TeX<HTMLElement, Text, Document>({ packages: AllPackages }),
    OutputJax: svg,
  });
  // MathJax's own container/stroke rules (sized SVG, baseline alignment, …)
  document.head.appendChild(svg.styleSheet(doc) as HTMLElement);
  const cache = new Map<string, string>();
  return (tex, display) => {
    const key = (display ? 'D:' : 'I:') + tex;
    let html = cache.get(key);
    if (html === undefined) {
      try {
        const node = doc.convert(tex, { display }) as HTMLElement;
        html = adaptor.outerHTML(node);
      } catch {
        html = '';
      }
      cache.set(key, html);
    }
    return html;
  };
}
