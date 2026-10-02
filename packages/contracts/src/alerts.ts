import type { MarketRef } from './market.js';
import type { PineValue } from './pine.js';

export interface PriceAlertCondition { kind: 'price'; operator: 'above' | 'below' | 'crosses_above' | 'crosses_below'; price: string }
export interface PineAlertCondition { kind: 'pine'; eventType: 'alert' | 'alertcondition'; title?: string }
export type AlertLeaf = PriceAlertCondition | PineAlertCondition;
export type AlertCondition = AlertLeaf | { kind: 'group'; operator: 'all' | 'any'; conditions: AlertLeaf[] };
export type AlertDestination = { kind: 'webhook'; id: string } | { kind: 'telegram'; chatId: string };
export interface AlertCommand {
  name: string; market: MarketRef; timeframe: string; mode: 'quote' | 'bar-close';
  frequency: 'once' | 'once_per_bar'; enabled: boolean; condition: AlertCondition;
  scriptRevisionId?: string; inputs?: Record<string, PineValue>; warmupFrom?: number;
  destinations: AlertDestination[];
}
export interface AlertDefinition extends Omit<AlertCommand, 'warmupFrom'> {
  id: string; revision: number; warmupFrom: number | null; watermark: number | null;
  pausedReason: string | null; createdAt: number; updatedAt: number;
}
export interface UpdateAlert extends AlertCommand { revision: number }
export interface AlertPayload {
  eventId: string; alertId: string; occurredAt: number; market: MarketRef;
  timeframe: string; message: string; scriptRevisionId?: string;
}
export interface AlertDelivery {
  id: string; eventId: string; destination: AlertDestination; state: 'pending' | 'sending' | 'delivered' | 'failed';
  attempts: number; nextAttemptAt: number; lastStatus: number | null; lastError: string | null;
  deliveredAt: number | null; createdAt: number;
}
export interface AlertEvent extends AlertPayload {
  alertRevision: number; kind: 'signal' | 'test' | 'missed'; createdAt: number; deliveries: AlertDelivery[];
  missed?: { from: number; to: number; count: number; reason: string };
}
export interface WebhookConfig { id: string; name: string; url: string; revision: number; secretConfigured: boolean; createdAt: number; updatedAt: number }
export interface CreateWebhook { name: string; url: string; secret: string }
export interface UpdateWebhook { revision: number; name: string; url: string; secret?: string }
export interface TelegramConfig {
  configured: boolean; revision: number; allowedChatIds: string[]; allowedUserIds: string[]; enabled: boolean;
  status: 'unconfigured' | 'checking' | 'connected' | 'unavailable' | 'webhook-conflict'; reason: string | null;
  botUsername: string | null; updateOffset: number;
  lastCommand?: { name: '/status' | '/alerts' | '/positions' | '/pause_alerts'; updateId: number; observedAt: number };
}
export interface UpdateTelegram { revision: number; token?: string; allowedChatIds: string[]; allowedUserIds: string[]; enabled: boolean }
export interface IntegrationTestResult { delivered: boolean; status: number | null; message: string; eventId: string; observedAt: number }
export interface NotificationStatus { paused: boolean; telegram: TelegramConfig }
