import { useState, useRef } from 'react';
import { cn } from '../lib/utils';

/**
 * 状态悬浮提示组件。
 * 用于源站管理、模型管理等表格中，鼠标悬停时展示状态详情
 * （HTTP 状态码、错误详情、最后检测时间等）。
 */
export function StatusTooltip({
  label,
  variant = 'secondary',
  reason = '',
  statusCode,
  detail,
  lastCheckText,
  children,
  className,
  align = 'center'
}) {
  const [visible, setVisible] = useState(false);
  const triggerRef = useRef(null);

  const dotColors = {
    success: 'bg-green-500',
    warning: 'bg-yellow-500',
    destructive: 'bg-red-500',
    secondary: 'bg-gray-400',
    outline: 'bg-gray-300'
  };

  return (
    <span
      ref={triggerRef}
      className={cn('relative inline-block', className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && (
        <div
          className={cn(
            'absolute z-[9999] bottom-full mb-2 w-64 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs',
            align === 'center' && 'left-1/2 -translate-x-1/2',
            align === 'left' && 'left-0',
            align === 'right' && 'right-0'
          )}
        >
          <div className="px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-1.5 font-semibold">
              <span className={cn('w-2 h-2 rounded-full', dotColors[variant] || dotColors.secondary)} />
              <span>{label || '状态'}</span>
            </div>
            {reason && (
              <div className="text-muted-foreground leading-snug whitespace-pre-line break-words">
                {reason}
              </div>
            )}
            {(statusCode != null || detail) && (
              <div className="space-y-1 border-t pt-1.5 border-slate-100 dark:border-slate-800">
                {statusCode != null && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground uppercase">HTTP</span>
                    <span className={cn(
                      'font-mono font-semibold',
                      statusCode >= 200 && statusCode < 300 ? 'text-emerald-600 dark:text-emerald-400' :
                      statusCode >= 400 ? 'text-destructive' : 'text-amber-600'
                    )}>
                      {statusCode}
                    </span>
                  </div>
                )}
                {detail && (
                  <div className="text-muted-foreground break-all leading-snug">
                    {detail}
                  </div>
                )}
              </div>
            )}
            {lastCheckText && (
              <div className="text-[10px] text-muted-foreground/70">
                最后检测：{lastCheckText}
              </div>
            )}
          </div>
          <div className="absolute left-1/2 -translate-x-1/2 -bottom-1 w-2 h-2 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 rotate-45" />
        </div>
      )}
    </span>
  );
}
