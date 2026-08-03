export function renderMarkdown(src: string): string {
  const lines = src.split("\n");
  let html = "";
  let inList = false;
  let listTag: string = "ul";

  const closeList = () => {
    if (inList) {
      html += `</${listTag}>`;
      inList = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    if (line.trimStart().startsWith("```")) {
      closeList();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      const code = escapeHtml(codeLines.join("\n"));
      html += `<pre class="md-code"><code>${code}</code></pre>`;
      continue;
    }

    const hd = line.match(/^(#{1,6})\s+(.+)/);
    if (hd) {
      closeList();
      const lvl = hd[1].length;
      html += `<h${lvl}>${parseInline(hd[2])}</h${lvl}>`;
      continue;
    }

    const ul = line.match(/^(\s*)[-*]\s+(.+)/);
    if (ul) {
      if (!inList) {
        html += `<ul class="md-list">`;
        inList = true;
        listTag = "ul";
      }
      html += `<li>${parseInline(ul[2])}</li>`;
      continue;
    }

    const ol = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (ol) {
      if (!inList) {
        html += `<ol class="md-list">`;
        inList = true;
        listTag = "ol";
      }
      html += `<li>${parseInline(ol[2])}</li>`;
      continue;
    }

    if (line.match(/^\s*>\s/)) {
      closeList();
      const text = line.replace(/^\s*>\s?/, "");
      html += `<blockquote>${parseInline(text)}</blockquote>`;
      continue;
    }

    if (/^\s*[-*_]{3,}\s*$/.test(line.trim())) {
      closeList();
      html += `<hr class="md-hr"/>`;
      continue;
    }

    if (line.trim() === "") {
      closeList();
      continue;
    }

    closeList();
    let para = line;
    while (
      i + 1 < lines.length &&
      lines[i + 1].trim() !== "" &&
      !lines[i + 1].match(/^(#{1,6})\s/) &&
      !lines[i + 1].match(/^\s*[-*]\s/) &&
      !lines[i + 1].match(/^(\s*)\d+\.\s/) &&
      !lines[i + 1].match(/^\s*>\s/) &&
      !lines[i + 1].trimStart().startsWith("```")
    ) {
      i++;
      para += "\n" + lines[i];
    }
    html += `<p>${parseInline(para)}</p>`;
  }
  closeList();
  return html;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseInline(text: string): string {
  text = text.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  text = text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-img" src="$2" alt="$1" />')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>');
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, "<strong><em>$1</em></strong>");
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return text;
}
