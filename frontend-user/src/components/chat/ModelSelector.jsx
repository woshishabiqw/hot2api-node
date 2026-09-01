import { useRef, useEffect, useState, memo } from 'react';
import { cn } from '../../lib/utils';
import { Card } from '../Card';
import { RefreshCw, ChevronDown, Cpu } from 'lucide-react';

const POP_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
const POP_DURATION = 220;

function msColor(ms) {
  if (ms == null) return 'text-muted-foreground';
  if (ms < 300) return 'text-emerald-500';
  if (ms < 800) return 'text-amber-500';
  return 'text-red-500';
}

function latencyDot(ms) {
  if (ms == null) return 'bg-muted-foreground/50';
  if (ms < 300) return 'bg-emerald-500';
  if (ms < 800) return 'bg-amber-500';
  return 'bg-red-500';
}

function ModelSelector({ models, selectedModel, latencies, onSelect, onRefresh, variant = 'inside' }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [closing, setClosing] = useState(false);
  const [animateIn, setAnimateIn] = useState(false);
  const [expandUp, setExpandUp] = useState(true);
  const [alignRight, setAlignRight] = useState(false);
  const [maxHeight, setMaxHeight] = useState(320);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const selectedInfo = models.find(m => m.model_id === selectedModel);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect();
        const spaceAbove = rect.top - 16;
        const spaceBelow = window.innerHeight - rect.bottom - 16;
        const minHeight = 160;
        const preferredHeight = Math.min(320, Math.max(minHeight, spaceAbove));
        const up = spaceAbove >= minHeight || spaceAbove >= spaceBelow;
        const mh = up
          ? Math.min(preferredHeight, spaceAbove)
          : Math.min(320, spaceBelow);
        setExpandUp(up);
        setAlignRight(rect.left + 320 > window.innerWidth);
        setMaxHeight(Math.max(minHeight, mh));
      }
      setMounted(true);
      setClosing(false);
      setAnimateIn(false);
      const raf = requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimateIn(true));
      });
      return () => cancelAnimationFrame(raf);
    } else if (mounted) {
      setAnimateIn(false);
      setClosing(true);
      const timer = setTimeout(() => setMounted(false), POP_DURATION);
      return () => clearTimeout(timer);
    }
  }, [open, mounted]);

  const ms = latencies[selectedModel];
  const visible = animateIn && !closing;

  return (
    <div className="relative" ref={ref}>
      <button
        ref={triggerRef}
        onClick={() => setOpen(o => !o)}
        disabled={models.length === 0}
        className={cn(
          "inline-flex items-center gap-1.5 transition-all disabled:opacity-50",
          variant === 'inside'
            ? "px-2 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-accent"
            : "px-3 py-1.5 rounded-full border bg-card hover:bg-accent text-xs"
        )}
      >
        <Cpu className="w-3 h-3" />
        <span className={cn("w-1.5 h-1.5 rounded-full", latencyDot(ms))} />
        <span className="truncate max-w-[120px]">
          {selectedInfo?.model_alias || selectedInfo?.model_id || '选择模型'}
        </span>
        {ms != null && ms > 0 && (
          <span className={cn("font-mono text-[10px]", msColor(ms))}>{ms}ms</span>
        )}
        <ChevronDown className={cn("w-3 h-3 transition-transform", open && "rotate-180")} />
      </button>

      {mounted && (
        <Card
          className={cn(
            "absolute w-80 p-2 z-50 shadow-xl overflow-hidden flex flex-col origin-bottom",
            visible
              ? "opacity-100 translate-y-0 scale-100 pointer-events-auto"
              : cn("opacity-0 scale-95 pointer-events-none", expandUp ? "translate-y-2" : "-translate-y-2")
          )}
          style={{
            [expandUp ? 'bottom' : 'top']: 'calc(100% + 8px)',
            [alignRight ? 'right' : 'left']: 0,
            maxHeight: `${maxHeight}px`,
            transition: `transform ${POP_DURATION}ms ${POP_EASE}, opacity ${POP_DURATION}ms ${POP_EASE}`,
          }}
        >
          <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground shrink-0">
            <span className="font-medium">选择模型</span>
            <button
              onClick={() => onRefresh?.()}
              className="inline-flex items-center gap-1 hover:text-foreground transition-colors"
            >
              <RefreshCw className="w-3 h-3" /> 刷新延迟
            </button>
          </div>
          <div className="overflow-y-auto custom-scrollbar space-y-0.5 min-h-0">
            {models.map(m => {
              const modelMs = latencies[m.model_id];
              const isSelected = m.model_id === selectedModel;
              return (
                <button
                  key={m.model_id}
                  onClick={() => { onSelect(m.model_id); setOpen(false); }}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm transition-all",
                    isSelected ? "bg-primary/10 text-primary" : "hover:bg-accent text-foreground"
                  )}
                >
                  <div className="flex flex-col items-start min-w-0 text-left">
                    <span className="font-medium truncate">{m.model_alias || m.model_id}</span>
                    <span className="text-[10px] text-muted-foreground truncate">{m.model_id}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={cn("w-1.5 h-1.5 rounded-full", latencyDot(modelMs))} />
                    <span className={cn("text-xs font-mono w-12 text-right", msColor(modelMs))}>
                      {modelMs != null && modelMs > 0 ? `${modelMs}ms` : '--'}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

export default memo(ModelSelector);
