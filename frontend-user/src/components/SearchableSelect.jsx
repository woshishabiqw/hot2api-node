import { useState, useEffect, useRef } from 'react';
import { cn } from '../lib/utils';

export default function SearchableSelect({
  label,
  placeholder,
  options,
  value,
  onChange,
  getValue = (o) => o.id,
  getLabel = (o) => String(o.name || o.username || o.title || o.id),
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const containerRef = useRef(null);

  const selected = options.find((o) => getValue(o) === value);
  const display = selected ? getLabel(selected) : '';

  const filtered = options.filter((o) => {
    const text = getLabel(o).toLowerCase();
    const key = String(getValue(o));
    const q = search.trim().toLowerCase();
    return !q || text.includes(q) || key.includes(q);
  });

  useEffect(() => {
    setSearch(display);
  }, [display]);

  useEffect(() => {
    function handleClick(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
        setSearch(display);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [display]);

  return (
    <div className="relative" ref={containerRef}>
      {label && (
        <label className="text-sm font-medium mb-1.5 block">{label}</label>
      )}
      <input
        type="text"
        disabled={disabled}
        className={cn(
          'w-full h-10 rounded-md border border-input bg-background px-3 text-sm',
          disabled && 'cursor-not-allowed opacity-60'
        )}
        placeholder={placeholder}
        value={search}
        onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
        onFocus={() => { setSearch(''); setOpen(true); }}
        onBlur={() => {
          setTimeout(() => { setOpen(false); setSearch(display); }, 150);
        }}
      />
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-background shadow-md">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">无匹配项</div>
          ) : (
            filtered.map((o) => (
              <div
                key={getValue(o)}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm hover:bg-accent',
                  getValue(o) === value && 'bg-accent'
                )}
                onMouseDown={() => {
                  onChange(o);
                  setOpen(false);
                }}
              >
                {getLabel(o)}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
