import { memo } from 'react';
import { Button } from '../Button';
import { PanelLeft, Plus, Sparkles } from 'lucide-react';

function ChatHeader({ title, onMenuClick, onNewSession }) {
  return (
    <header className="relative z-[60] flex items-center justify-between px-4 py-3 shrink-0 border-b bg-card/50">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onMenuClick} title="历史对话">
          <PanelLeft className="w-4 h-4" />
        </Button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-primary" />
          </div>
          <h1 className="font-semibold text-sm truncate max-w-[200px] sm:max-w-md">
            {title || '网页聊天'}
          </h1>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onNewSession} className="gap-1.5">
        <Plus className="w-3.5 h-3.5" />
        新对话
      </Button>
    </header>
  );
}

export default memo(ChatHeader);
