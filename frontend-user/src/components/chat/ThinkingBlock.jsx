import { useState, useEffect, memo } from 'react';
import { cn } from '../../lib/utils';
import { Activity, ChevronDown } from 'lucide-react';
import CitationDot from './CitationDot';

function CitationText({ text, sources = [] }) {
  const parts = text.split(/(\[\^?\d+\])/g);
  return parts.map((p, i) => {
    const match = p.match(/^\[(\^?\d+)\]$/);
    if (match) {
      const idx = parseInt(match[1].replace('^', ''), 10);
      const source = sources[idx - 1];
      return <CitationDot key={i} index={idx} source={source} />;
    }
    return <span key={i}>{p}</span>;
  });
}

function ThinkingBlock({ reasoning, done, sources = [] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!reasoning) return;
    if (!done) {
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, [reasoning, done]);

  if (!reasoning) return null;

  return (
    <div className="mb-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-amber-700 dark:text-amber-300 hover:bg-amber-500/5 transition-colors"
      >
        <span className="flex items-center gap-2 font-medium">
          <Activity className="w-3.5 h-3.5" />
          思考过程
          <span className="opacity-60 font-normal">({reasoning.length} 字)</span>
        </span>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-300 ease-in-out',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="overflow-hidden">
          <div className="px-3 pb-3 pt-1 text-sm text-amber-800/70 dark:text-amber-200/70 whitespace-pre-wrap leading-relaxed">
            <CitationText text={reasoning} sources={sources} />
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(ThinkingBlock);
