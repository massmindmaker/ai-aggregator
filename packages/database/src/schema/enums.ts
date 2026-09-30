import { pgEnum } from 'drizzle-orm/pg-core';

// User role types
export const userRoleEnum = pgEnum('user_role', [
  'user',
  'developer',
  'admin',
  'moderator',
]);

// Organization role types
export const orgRoleEnum = pgEnum('org_role', [
  'owner',
  'admin',
  'developer',
  'viewer',
]);

// AI Model types
export const modelTypeEnum = pgEnum('model_type', [
  'llm',
  'image',
  'audio',
  'video',
  'multimodal',
  'embedding',
  'code',
  'speech-to-text',
  'text-to-speech',
]);

// Model status
export const modelStatusEnum = pgEnum('model_status', [
  'draft',
  'pending_review',
  'published',
  'deprecated',
  'archived',
]);

// Pricing types
export const pricingTypeEnum = pgEnum('pricing_type', [
  'free',
  'freemium',
  'pay_per_use',
  'subscription',
  'custom',
]);

// Subscription status
export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'paused',
  'cancelled',
  'expired',
  'trial',
  // Created at payment initiation, not yet paid. CONFIRMED webhook -> 'active'.
  'pending',
]);

// Payment status
export const paymentStatusEnum = pgEnum('payment_status', [
  'pending',
  'authorized',
  'confirmed',
  'refunded',
  'partial_refunded',
  'cancelled',
  'rejected',
  'failed',
]);

// API Key status
export const apiKeyStatusEnum = pgEnum('api_key_status', [
  'active',
  'revoked',
  'expired',
]);

// Request types for marketplace requests
export const requestTypeEnum = pgEnum('request_type', [
  'api_development',
  'integration',
  'custom_model',
  'consulting',
]);

// Request status
export const requestStatusEnum = pgEnum('request_status', [
  'open',
  'in_progress',
  'completed',
  'cancelled',
]);

// HTTP Methods
export const httpMethodEnum = pgEnum('http_method', [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

// Notification types
export const notificationTypeEnum = pgEnum('notification_type', [
  'system',
  'payment',
  'subscription',
  'api_update',
  'contest',
  'message',
]);
