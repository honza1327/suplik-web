'use strict';

// Obarvení Markdownu v editoru – stejná pravidla jako v Šuplíku na Macu (MarkdownHighlighter.swift).
// Vrací HTML s barevnými úseky; znaky se nemění, jen se obalí do <span>.
const Highlight = (() => {
  let rules;
  try {
    const W = '[\\p{L}\\p{N}_]';
    const re = (src, flags = '') => new RegExp(src, 'gmdu' + flags);
    rules = {
      heading: re('^(#{1,6})([ \\t]+)(.*)$'),
      task: re('^([ \\t]*[-*+][ \\t]+)(\\[[ xX]\\])([ \\t]+)(.*)$'),
      list: re('^[ \\t]*([-*+]|\\d+[.)])[ \\t]+'),
      quote: re('^[ \\t]*(>+)(.*)$'),
      rule: re('^[ \\t]*([-*_])([ \\t]*\\1){2,}[ \\t]*$'),
      tableRow: re('^[ \\t]*\\|.*$'),
      tableRule: re('^[ \\t]*\\|?[ \\t:|-]*-{3,}[ \\t:|-]*$'),
      bold: re('(\\*\\*|__)(?=\\S)(.+?)(?<=\\S)\\1'),
      italic: re(`(?<![*${W.slice(1, -1)}])(\\*|_)(?=[^\\s*_])(.+?)(?<=[^\\s*_])\\1(?![*${W.slice(1, -1)}])`),
      strike: re('~~(?=\\S)(.+?)(?<=\\S)~~'),
      link: re('(!?\\[)([^\\]\\n]*)(\\]\\()([^)\\n]*)(\\))'),
      url: re(`(?<![(<${W.slice(1, -1)}])https?://[^\\s)>\\]]+`),
      code: re('`[^`\\n]+`'),
      fence: re('^[ \\t]*```[\\s\\S]*?^[ \\t]*```[ \\t]*$'),
    };
  } catch {
    rules = null;   // starší Safari bez potřebných regulárních výrazů – editor zůstane jednobarevný
  }

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // marks: další zvýraznění [začátek, konec, třída] (např. nálezy hledání); markdown=false jen pro ně.
  function html(text, { markdown = true, marks = [] } = {}) {
    if (!rules) return esc(text);
    const n = text.length;
    const cls = new Array(n).fill('');
    const add = (span, c) => { if (span) for (let i = span[0]; i < span[1]; i++) cls[i] += ' ' + c; };
    const set = (span, c) => { if (span) for (let i = span[0]; i < span[1]; i++) cls[i] = c; };
    const each = (r, f) => {
      r.lastIndex = 0;
      let m;
      while ((m = r.exec(text))) {
        if (m[0].length === 0) { r.lastIndex++; continue; }
        f(m.indices, m);
      }
    };
    const ends = (span, len) => { add([span[0], span[0] + len], 'md-dim'); add([span[1] - len, span[1]], 'md-dim'); };

    if (markdown) markdownRules(text, cls, add, set, each, ends);
    for (const [s, e, c] of marks) add([s, e], c);
    return render(text, cls);
  }

  function markdownRules(text, cls, add, set, each, ends) {
    each(rules.heading, (ix) => { add(ix[0], 'md-h'); add(ix[1], 'md-dim'); });
    each(rules.list, (ix) => add(ix[1], 'md-mark'));
    each(rules.task, (ix, m) => {
      add(ix[2], 'md-mark');
      if (m[2] !== '[ ]') add(ix[4], 'md-s');   // hotový úkol je ztlumený
    });
    each(rules.quote, (ix) => { add(ix[1], 'md-mark'); add(ix[2], 'md-muted md-i'); });
    each(rules.rule, (ix) => add(ix[0], 'md-dim'));
    each(rules.tableRow, (ix) => {
      for (let i = ix[0][0]; i < ix[0][1]; i++) if (text[i] === '|') cls[i] += ' md-dim';
    });
    each(rules.tableRule, (ix) => add(ix[0], 'md-dim'));
    each(rules.bold, (ix) => { add(ix[0], 'md-b'); ends(ix[0], 2); });
    each(rules.italic, (ix) => { add(ix[0], 'md-i'); ends(ix[0], 1); });
    each(rules.strike, (ix) => { add(ix[1], 'md-s'); ends(ix[0], 2); });
    each(rules.link, (ix) => { add(ix[1], 'md-dim'); add(ix[2], 'md-link'); add(ix[3], 'md-dim'); add(ix[4], 'md-dim'); add(ix[5], 'md-dim'); });
    each(rules.url, (ix) => add(ix[0], 'md-link'));
    // Kód má přednost: uvnitř se nic dalšího nebarví.
    each(rules.code, (ix) => set(ix[0], ' md-code'));
    each(rules.fence, (ix) => set(ix[0], ' md-code'));
  }

  function render(text, cls) {
    const n = text.length;
    let out = '';
    let i = 0;
    while (i < n) {
      let j = i + 1;
      while (j < n && cls[j] === cls[i]) j++;
      const chunk = esc(text.slice(i, j));
      out += cls[i] ? `<span class="${cls[i].trim()}">${chunk}</span>` : chunk;
      i = j;
    }
    return out;
  }

  return { html, ok: rules !== null };
})();
