import { useState } from 'react';
import { cn } from '../../lib/utils';
import { Copy, Check } from 'lucide-react';
import CitationDot from './CitationDot';

function CopyButton({ text, className }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <button
      onClick={handleCopy}
      className={cn(
        "p-1.5 rounded-md hover:bg-primary/10 text-muted-foreground transition-colors",
        className
      )}
      title="复制"
    >
      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

function renderInline(s, sources = []) {
  const parts = s.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[\^?\d+\])/g);
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>;
    }
    if (p.startsWith('*') && p.endsWith('*')) {
      return <em key={i}>{p.slice(1, -1)}</em>;
    }
    if (p.startsWith('`') && p.endsWith('`')) {
      return (
        <code
          key={i}
          className="px-1.5 py-0.5 rounded-md bg-muted text-xs font-mono border"
        >
          {p.slice(1, -1)}
        </code>
      );
    }
    const citationMatch = p.match(/^\[(\^?\d+)\]$/);
    if (citationMatch) {
      const idx = parseInt(citationMatch[1].replace('^', ''), 10);
      const source = sources[idx - 1];
      return <CitationDot key={i} index={idx} source={source} />;
    }
    return <span key={i}>{p}</span>;
  });
}

export default function MarkdownRender({ text, className, sources = [] }) {
  if (!text) return null;

  const lines = text.split('\n');
  const result = [];
  let inCode = false;
  let codeLang = '';
  let codeContent = [];

  const flushCode = () => {
    if (!inCode) return;
    result.push(
      <div key={`code-${result.length}`} className="my-4 rounded-lg overflow-hidden border bg-card">
        <div className="flex items-center justify-between px-3 py-2 bg-muted border-b">
          <span className="text-xs text-muted-foreground font-mono">{codeLang || 'code'}</span>
          <CopyButton text={codeContent.join('\n')} />
        </div>
        <pre className="p-4 overflow-x-auto text-sm text-foreground font-mono leading-relaxed bg-card">
          <code>{codeContent.join('\n')}</code>
        </pre>
      </div>
    );
    inCode = false;
    codeLang = '';
    codeContent = [];
  };

  lines.forEach((line, idx) => {
    if (line.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = line.slice(3).trim();
      } else {
        flushCode();
      }
      return;
    }
    if (inCode) {
      codeContent.push(line);
      return;
    }

    if (line.startsWith('### ')) {
      result.push(<h3 key={idx} className="text-lg font-semibold mt-4 mb-2">{renderInline(line.slice(4), sources)}</h3>);
    } else if (line.startsWith('## ')) {
      result.push(<h2 key={idx} className="text-xl font-semibold mt-5 mb-3">{renderInline(line.slice(3), sources)}</h2>);
    } else if (line.startsWith('# ')) {
      result.push(<h1 key={idx} className="text-2xl font-bold mt-6 mb-4">{renderInline(line.slice(2), sources)}</h1>);
    } else if (line.startsWith('> ')) {
      result.push(
        <blockquote key={idx} className="border-l-2 border-primary/30 pl-4 py-1 my-3 text-muted-foreground italic">
          {renderInline(line.slice(2), sources)}
        </blockquote>
      );
    } else if (/^\d+\.\s/.test(line)) {
      result.push(
        <div key={idx} className="flex gap-2 my-1">
          <span className="text-muted-foreground font-mono min-w-[1.5rem]">{line.match(/^\d+/)[0]}.</span>
          <span>{renderInline(line.replace(/^\d+\.\s/, ''), sources)}</span>
        </div>
      );
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      result.push(
        <div key={idx} className="flex gap-2 my-1">
          <span className="text-primary mt-2 w-1 h-1 rounded-full bg-primary shrink-0" />
          <span>{renderInline(line.slice(2), sources)}</span>
        </div>
      );
    } else if (line.trim() === '') {
      result.push(<div key={idx} className="h-2" />);
    } else {
      result.push(<p key={idx} className="leading-7 my-1">{renderInline(line, sources)}</p>);
    }
  });

  flushCode();
  return <div className={cn('break-words', className)}>{result}</div>;
}
