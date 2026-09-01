import { useState, useCallback } from 'react';
import { Button } from './Button';

let _setDialog = null;

export function showAlert(message) {
  return new Promise(resolve => {
    _setDialog?.({ type: 'alert', message, resolve });
  });
}

export function showConfirm(message) {
  return new Promise(resolve => {
    _setDialog?.({ type: 'confirm', message, resolve });
  });
}

export function DialogProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  _setDialog = setDialog;

  return (
    <>
      {children}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-card border rounded-lg shadow-lg p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()} style={{userSelect: 'text'}}>
            <p className="text-sm mb-4 whitespace-pre-wrap select-text">{dialog.message}</p>
            <div className="flex justify-end gap-2">
              {dialog.type === 'confirm' && (
                <Button variant="outline" size="sm" onClick={(e) => { e.preventDefault(); dialog.resolve(false); setDialog(null); }}>取消</Button>
              )}
              <Button size="sm" onClick={(e) => { e.preventDefault(); dialog.resolve(true); setDialog(null); }}>确定</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
