import { memo, useState } from 'react';
import { cn } from '../../lib/utils';
import { Badge } from '../Badge';
import { Button } from '../Button';
import MarkdownRender from './MarkdownRender';
import ThinkingBlock from './ThinkingBlock';
import SearchProgress from './SearchProgress';
import { Bot, User, Copy, Check, RotateCcw, Clock, Coins } from 'lucide-react';

function formatTokens(n) {
  if (n == null || isNaN(n)) return '0';
  return n.toLocaleString();
}

function formatSpeed(tps) {
  if (!isFinite(tps) || tps <= 0) return '0.0';
  return tps.toFixed(1);
}

function formatCost(n) {
  if (n == null || !isFinite(n) || n <= 0) return null;
  if (n < 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function MessageActions({ content, onRegenerate, vertical }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className={cn(
      "flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity",
      vertical ? "flex-col" : "items-center"
    )}>
      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copy} title="复制">
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </Button>
      {onRegenerate && (
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRegenerate} title="重新生成">
          <RotateCcw className="w-3.5 h-3.5" />
        </Button>
      )}
    </div>
  );
}

function TokenStats({ stats }) {
  if (!stats) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-2 mt-2 border-t">
      {stats.inputTokens > 0 && (
        <Badge variant="secondary" className="text-[10px] font-normal">
          输入 {formatTokens(stats.inputTokens)}
        </Badge>
      )}
      {stats.outputTokens > 0 && (
        <Badge variant="secondary" className="text-[10px] font-normal">
          输出 {formatTokens(stats.outputTokens)}
        </Badge>
      )}
      {stats.totalTokens > 0 && (
        <Badge variant="secondary" className="text-[10px] font-normal">
          总计 {formatTokens(stats.totalTokens)}
        </Badge>
      )}
      {stats.firstTokenMs > 0 && (
        <Badge variant="secondary" className="text-[10px] font-normal inline-flex items-center gap-1">
          <Clock className="w-3 h-3" /> 首字 {stats.firstTokenMs}ms
        </Badge>
      )}
      {stats.speed > 0 && (
        <Badge variant="secondary" className="text-[10px] font-normal inline-flex items-center gap-1">
          ⚡ {formatSpeed(stats.speed)} tok/s
        </Badge>
      )}
      {formatCost(stats.cost) && (
        <Badge variant="secondary" className="text-[10px] font-normal inline-flex items-center gap-1">
          <Coins className="w-3 h-3" /> {formatCost(stats.cost)}
        </Badge>
      )}
    </div>
  );
}

function ChatMessage({ msg, index, onRegenerate }) {
  const stats = msg.stats;
  const isUser = msg.role === 'user';
  const showSearchProgress = !isUser && msg.searchProgress && msg.searchProgress.length > 0;

  if (isUser) {
    return (
      <div className="flex justify-end px-4 py-1.5 message-row">
        <div className="max-w-[85%] sm:max-w-[65%]">
          <div className="flex items-start gap-3 flex-row-reverse">
            <div className="w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shrink-0 shadow-sm">
              <User className="w-4 h-4" />
            </div>
            <div className="rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-4 py-2.5 text-[15px] leading-7 shadow-sm">
              <MarkdownRender text={msg.content} sources={msg.sources} />
            </div>
          </div>
          <div className="text-[10px] text-muted-foreground text-right mt-0.5 pr-10">
            {formatTime(msg.timestamp)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex px-4 py-1.5 group message-row">
      <div className="flex gap-3 max-w-full w-full items-start">
        <div className="w-8 h-8 rounded-full bg-secondary text-secondary-foreground flex items-center justify-center shrink-0 shadow-sm border">
          <Bot className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          <div
            className={cn(
              "rounded-2xl rounded-tl-sm border bg-card p-4 shadow-sm",
              msg.error && "border-destructive/50 bg-destructive/5"
            )}
          >
            {showSearchProgress ? (
              <>
                {msg.reasoning && <ThinkingBlock reasoning={msg.reasoning} done={false} sources={msg.sources} />}
                <SearchProgress steps={msg.searchProgress} embedded />
              </>
            ) : (
              <>
                <ThinkingBlock reasoning={msg.reasoning} done={msg.done} sources={msg.sources} />
                <div className={cn('text-[15px] leading-7 min-h-[48px]', msg.error && 'text-destructive')}>
                  {msg.content ? (
                    <MarkdownRender text={msg.content} sources={msg.sources} />
                  ) : (
                    <span className="inline-flex items-center gap-2 text-muted-foreground">
                      <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                      正在思考…
                    </span>
                  )}
                </div>
                <TokenStats stats={stats} />
              </>
            )}
          </div>
        </div>

        {!showSearchProgress && (
          <MessageActions
            content={msg.content}
            onRegenerate={onRegenerate}
            vertical
          />
        )}
      </div>
    </div>
  );
}

export default memo(ChatMessage);
