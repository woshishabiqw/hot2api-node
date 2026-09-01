import { memo, useEffect, useMemo, useRef } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../Button';
import { Card } from '../Card';
import { MessageSquare, Trash2, Plus, X } from 'lucide-react';

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const isYesterday = new Date(now - 86400000).toDateString() === d.toDateString();
  if (isToday) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (isYesterday) return '昨天';
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function groupSessions(sessions) {
  const groups = { 今天: [], 昨天: [], 最近7天: [], 更早: [] };
  const now = Date.now();
  const today = new Date().toDateString();
  const yesterday = new Date(now - 86400000).toDateString();
  for (const s of sessions) {
    const d = new Date(s.updatedAt);
    if (d.toDateString() === today) groups['今天'].push(s);
    else if (d.toDateString() === yesterday) groups['昨天'].push(s);
    else if (now - s.updatedAt < 7 * 86400000) groups['最近7天'].push(s);
    else groups['更早'].push(s);
  }
  return groups;
}

function SessionSelectorModal({ sessions, activeSessionId, onCreate, onSelect, onDelete, open, onClose }) {
  const grouped = groupSessions(sessions);
  const activeItemRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [open, activeSessionId]);

  const sortedEntries = useMemo(() =>
    Object.entries(grouped).map(([name, list]) => [name, [...list].sort((a, b) => b.updatedAt - a.updatedAt)]),
    [grouped]
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative z-10 flex flex-col w-full max-w-md max-h-[75vh] shadow-2xl border border-border/50">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="font-semibold text-sm">选择对话</h2>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} title="关闭">
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-3 border-b">
          <Button onClick={onCreate} className="w-full gap-2">
            <Plus className="w-4 h-4" />
            新建对话
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-4 min-h-0">
          {sessions.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">暂无历史对话</div>
          ) : (
            sortedEntries.map(([groupName, group]) =>
              group.length > 0 ? (
                <div key={groupName}>
                  <div className="px-2 mb-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                    {groupName}
                  </div>
                  <div className="space-y-1">
                    {group.map(session => {
                      const isActive = session.id === activeSessionId;
                      return (
                        <button
                          key={session.id}
                          ref={isActive ? activeItemRef : null}
                          onClick={() => onSelect(session.id)}
                          className={cn(
                            "w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-left transition-colors group",
                            isActive
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          )}
                        >
                          <MessageSquare className="w-3.5 h-3.5 shrink-0 opacity-70" />
                          <span className="flex-1 truncate">{session.title || '新对话'}</span>
                          <span className="text-[11px] opacity-60 shrink-0">{formatDate(session.updatedAt)}</span>
                          <span
                            onClick={(e) => onDelete(e, session.id)}
                            className={cn(
                              "opacity-0 group-hover:opacity-100 p-1 rounded-md transition-opacity shrink-0",
                              isActive
                                ? "hover:bg-primary-foreground/20"
                                : "hover:bg-destructive/10 hover:text-destructive"
                            )}
                            title="删除"
                          >
                            <Trash2 className="w-3 h-3" />
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : null
            )
          )}
        </div>
      </Card>
    </div>
  );
}

export default memo(SessionSelectorModal);
