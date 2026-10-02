import './alerts.css';

export function SettingsNavigation({ active, onData, onSecurity, onNotifications, disabled = false }: {
  active: 'data' | 'security' | 'notifications'; onData: () => void; onSecurity: () => void; onNotifications: () => void; disabled?: boolean;
}) {
  return <nav className="notification-navigation" aria-label="Settings sections">
    {([{ id: 'data', label: 'Data', open: onData }, { id: 'security', label: 'API keys & security', open: onSecurity }, { id: 'notifications', label: 'Notifications', open: onNotifications }] as const).map((item) => <button key={item.id} type="button" aria-current={active === item.id ? 'page' : undefined} disabled={disabled || active === item.id} onClick={item.open}>{item.label}</button>)}
  </nav>;
}
