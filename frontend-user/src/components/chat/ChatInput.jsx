import { useRef, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../Button';
import { Card } from '../Card';
import ModelSelector from './ModelSelector';
import { Send, Square, Info, Brain, Globe } from 'lucide-react';

function ChatInput({
  input,
  setInput,
  onSend,
  onStop,
  loading,
  models,
  selectedModel,
  latencies,
  onSelectModel,
  onRefreshLatencies,
  reasoningEnabled,
  onToggleReasoning,
  webSearchEnabled,
  onToggleWebSearch,
  webSearchAvailable,
}) {
  const textareaRef = useRef(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  };

  return (
    <div className="shrink-0 px-4 pt-3 pb-3 animate-chat-input-enter">
      <div className="w-full">
        <Card className="p-3 shadow-lg rounded-t-xl rounded-b-none overflow-visible flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="有问题，尽管问"
            rows={1}
            disabled={loading}
            className={cn(
              "flex-1 bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground px-2 py-2 text-[15px] resize-none max-h-[200px] min-h-[40px] disabled:opacity-60"
            )}
          />

          <div className="flex items-center gap-2 shrink-0 pb-0.5">
            <ModelSelector
              models={models}
              selectedModel={selectedModel}
              latencies={latencies}
              onSelect={onSelectModel}
              onRefresh={onRefreshLatencies}
              variant="inside"
            />
            {webSearchAvailable && (
              <Button
                variant={webSearchEnabled ? 'secondary' : 'ghost'}
                size="sm"
                className={cn(
                  "h-8 px-2 rounded-lg gap-1.5 text-xs transition-all duration-300 ease-in-out overflow-hidden min-w-0",
                  webSearchEnabled && "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20 hover:text-emerald-700"
                )}
                onClick={onToggleWebSearch}
                title={webSearchEnabled ? '已开启联网搜索' : '开启联网搜索'}
              >
                <Globe className="w-3.5 h-3.5 shrink-0" />
                <span
                  className={cn(
                    "whitespace-nowrap overflow-hidden transition-all duration-300 ease-in-out",
                    webSearchEnabled ? "max-w-0 opacity-0" : "max-w-[5rem] opacity-100"
                  )}
                >
                  联网搜索
                </span>
              </Button>
            )}
            <Button
              variant={reasoningEnabled ? 'secondary' : 'ghost'}
              size="sm"
              className={cn(
                "h-8 px-2 rounded-lg gap-1.5 text-xs transition-all duration-300 ease-in-out overflow-hidden min-w-0",
                reasoningEnabled && "bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 hover:text-amber-700"
              )}
              onClick={onToggleReasoning}
              title={reasoningEnabled ? '已开启深度思考' : '开启深度思考'}
            >
              <Brain className="w-4 h-4 shrink-0" />
              <span
                className={cn(
                  "whitespace-nowrap overflow-hidden transition-all duration-300 ease-in-out",
                  reasoningEnabled ? "max-w-0 opacity-0" : "max-w-[5rem] opacity-100"
                )}
              >
                深度思考
              </span>
            </Button>
            <span
              className="text-muted-foreground hover:text-foreground cursor-help transition-colors"
              title="AI 生成的内容可能存在错误，请核查重要信息。"
            >
              <Info className="w-4 h-4" />
            </span>
            {loading ? (
              <Button
                variant="secondary"
                size="icon"
                className="h-10 w-10 rounded-xl"
                onClick={onStop}
              >
                <Square className="w-4 h-4" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="h-10 w-10 rounded-xl"
                onClick={onSend}
                disabled={!input.trim() || !selectedModel}
              >
                <Send className="w-4 h-4" />
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default ChatInput;
