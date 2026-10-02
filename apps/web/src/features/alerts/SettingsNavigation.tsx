import './alerts.css';

export function SettingsNavigation({ active, onData, onSecurity, onNotifications, onExecution, onAgent, disabled = false }: {
  active: 'data' | 'security' | 'notifications' | 'execution' | 'agent'; onData: () => void; onSecurity: () => void; onNotifications: () => void; onExecution: () => void; onAgent: () => void; disabled?: boolean;
}) {
  return <nav className="notification-navigation" aria-label="Settings sections">
    {([{ id: 'data', label: 'Data', open: onData }, { id: 'security', label: 'API keys & security', open: onSecurity }, { id: 'notifications', label: 'Notifications', open: onNotifications }, { id: 'execution', label: 'Execution', open: onExecution }, { id: 'agent', label: 'Pi model', open: onAgent }] as const).map((item) => <button key={item.id} type="button" aria-current={active === item.id ? 'page' : undefined} disabled={disabled || active === item.id} onClick={item.open}>{item.label}</button>)}
  </nav>;
}
