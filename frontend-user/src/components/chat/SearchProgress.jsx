import { Search, Loader2, CheckCircle2, Brain, Sparkles, Lightbulb } from 'lucide-react';
import { cn } from '../../lib/utils';

function phaseIcon(phase) {
  if (phase === 'search') return <Search className="w-3.5 h-3.5" />;
  if (phase === 'think') return <Lightbulb className="w-3.5 h-3.5" />;
  if (phase === 'analyze') return <Brain className="w-3.5 h-3.5" />;
  if (phase === 'synthesize') return <Sparkles className="w-3.5 h-3.5" />;
  if (phase === 'done') return <CheckCircle2 className="w-3.5 h-3.5" />;
  return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
}

export default function SearchProgress({ steps, embedded = false }) {
  if (!steps || steps.length === 0) return null;

  // Show the latest event for each step, plus current phase
  const latestByStep = {};
  steps.forEach((s) => {
    latestByStep[s.step || 0] = s;
  });
  const ordered = Object.values(latestByStep).sort((a, b) => (a.step || 0) - (b.step || 0));
  const current = steps[steps.length - 1];

  return (
    <div className={cn(!embedded && 'max-w-3xl mx-auto px-4 py-2')}>
      <div className={cn(
        'rounded-xl',
        embedded ? 'bg-transparent' : 'border bg-card/80 backdrop-blur-sm p-3 shadow-sm'
      )}>
        <div className="flex items-center gap-2 text-xs font-medium text-foreground mb-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
          联网搜索中
        </div>
        <div className="space-y-1.5">
          {ordered.map((s, idx) => (
            <div
              key={idx}
              className={cn(
                "flex items-center gap-2 text-xs",
                s === current ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              <span className={cn(
                "flex items-center justify-center w-5 h-5 rounded-full shrink-0",
                s.phase === 'done' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-primary/10 text-primary'
              )}>
                {phaseIcon(s.phase)}
              </span>
              <span className="truncate">{s.message || s.query}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
