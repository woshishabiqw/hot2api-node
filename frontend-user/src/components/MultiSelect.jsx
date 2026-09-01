import { useState, useRef, useEffect } from 'react';
import { ChevronDown, X, Check } from 'lucide-react';
import { cn } from '../lib/utils';

export function MultiSelect({ options, value = [], onChange, placeholder = '请选择', className }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const toggle = (item) => {
    const next = value.includes(item) ? value.filter(v => v !== item) : [...value, item];
    onChange(next);
  };

  const clear = (e) => {
    e.stopPropagation();
    onChange([]);
  };

  const displayText = () => {
    if (value.length === 0) return placeholder;
    if (value.length <= 2) return value.join(', ');
    return `${value[0]} 等${value.length}项`;
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <div
        className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <span className={value.length === 0 ? 'text-muted-foreground' : ''}>{displayText()}</span>
        <div className="flex items-center gap-1">
          {value.length > 0 && (
            <button onClick={clear} className="p-0.5 hover:bg-accent rounded">
              <X className="w-3 h-3" />
            </button>
          )}
          <ChevronDown className="w-4 h-4 opacity-50" />
        </div>
      </div>
      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-60 overflow-auto rounded-xl border border-white/20 dark:border-white/10 shadow-2xl backdrop-blur-xl bg-white/80 dark:bg-slate-900/80 custom-scrollbar">
          {options.map((opt) => {
            const isSelected = value.includes(opt.value);
            return (
              <div
                key={opt.value}
                className={cn(
                  "flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors hover:bg-primary/10",
                  isSelected && "bg-primary/10"
                )}
                onClick={() => toggle(opt.value)}
              >
                <div className={cn(
                  "w-4 h-4 rounded border flex items-center justify-center transition-colors",
                  isSelected ? "bg-primary border-primary" : "border-input"
                )}>
                  {isSelected && <Check className="w-3 h-3 text-primary-foreground" />}
                </div>
                <span>{opt.label}</span>
                {opt.description && <span className="text-xs text-muted-foreground ml-auto">{opt.description}</span>}
              </div>
            );
          })}
          {options.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">无可用选项</div>
          )}
        </div>
      )}
    </div>
  );
}
