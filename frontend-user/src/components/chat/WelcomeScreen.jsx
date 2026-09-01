import { useRef, useEffect } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../Button';
import { Card } from '../Card';
import ModelSelector from './ModelSelector';
import { Send, Sparkles, Brain, Globe } from 'lucide-react';

const starterPrompts = [
  '帮我写一段 Python 快速排序',
  '用一句话解释深度学习',
  '帮我起草一封工作邮件',
  '推荐几本人工智能入门书籍',
];

function WelcomeScreen({
  input,
  setInput,
  onSend,
  loading,
  selectedModel,
  models,
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
    <div className="h-full flex flex-col items-center justify-center px-4 pb-16">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-6">
        <Sparkles className="w-8 h-8 text-primary" />
      </div>
      <h2 className="text-3xl font-semibold mb-2 text-center">你今天在想些什么？</h2>
      <p className="text-muted-foreground text-sm mb-8 text-center">选择一个模型，开始你的 AI 对话</p>

      <div className="w-full max-w-3xl">
        <Card className="p-4 shadow-lg rounded-2xl overflow-visible">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="有问题，尽管问"
            rows={1}
            className={cn(
              "w-full bg-transparent border-none outline-none text-foreground placeholder:text-muted-foreground px-2 py-3 text-lg resize-none max-h-[200px] min-h-[56px]"
            )}
          />
          <div className="flex items-center justify-between mt-2 pt-3 border-t">
            <div className="flex items-center gap-2">
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
                <Brain className="w-3.5 h-3.5 shrink-0" />
                <span
                  className={cn(
                    "whitespace-nowrap overflow-hidden transition-all duration-300 ease-in-out",
                    reasoningEnabled ? "max-w-0 opacity-0" : "max-w-[5rem] opacity-100"
                  )}
                >
                  深度思考
                </span>
              </Button>
            </div>
            <Button
              size="icon"
              className="h-10 w-10 rounded-xl"
              onClick={onSend}
              disabled={!input.trim() || !selectedModel || loading}
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </Card>

        <div className="flex justify-center gap-2 mt-6 flex-wrap">
          {starterPrompts.map((text, i) => (
            <button
              key={i}
              onClick={() => { setInput(text); textareaRef.current?.focus(); }}
              className="px-4 py-2 rounded-full border bg-card hover:bg-accent hover:text-foreground transition-all text-sm text-muted-foreground"
            >
              {text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default WelcomeScreen;
