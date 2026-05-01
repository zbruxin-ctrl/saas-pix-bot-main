// Tipos compartilhados entre todos os apps do monorepo
// ALTERAÇÕES: TOKEN→FILE_MEDIA, CANCELLED em OrderStatus, novos DTOs (DeliveryLog, DeliveryMedia,
// WebhookEvent, StockItem, OrderDetail), DashboardStats com métricas operacionais
// WALLET: WalletTransactionType, WalletTransactionDTO, CreateDepositRequest/Response,
//         WalletBalanceResponse, WalletAdjustRequest
// PRODUCT: sortOrder em ProductDTO
// PAYMENT: paidWithBalance em CreatePaymentResponse
// PAYMENT METHOD: paymentMethod em CreatePaymentRequest (BALANCE | PIX | MIXED)
// PRICING: couponCode, referralCode, quantity em CreatePaymentRequest
//          CouponDTO, ReferralDTO, VolumeTierDTO adicionados

// ─── Enums ────────────────────────────────────────────────────────────────────

export type PaymentStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'REFUNDED';

export type DeliveryType = 'TEXT' | 'LINK' | 'FILE_MEDIA' | 'ACCOUNT';

export type OrderStatus = 'PROCESSING' | 'DELIVERED' | 'FAILED' | 'CANCELLED';

export type AdminRole = 'SUPERADMIN' | 'ADMIN' | 'OPERATOR';

export type StockItemStatus = 'AVAILABLE' | 'RESERVED' | 'CONFIRMED' | 'DELIVERED';

export type StockReservationStatus = 'ACTIVE' | 'CONFIRMED' | 'RELEASED';

export type DeliveryLogStatus = 'SUCCESS' | 'FAILED' | 'RETRYING';

export type DeliveryMediaType = 'IMAGE' | 'VIDEO' | 'FILE';

export type WebhookEventStatus =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'FAILED'
  | 'IGNORED';

export type WalletTransactionType = 'DEPOSIT' | 'PURCHASE' | 'REFUND';

/** Método de pagamento escolhido pelo usuário no bot */
export type PaymentMethod = 'BALANCE' | 'PIX' | 'MIXED';

export type DiscountType = 'PERCENT' | 'FIXED';

// ─── DTOs base ────────────────────────────────────────────────────────────────

export interface ProductDTO {
  id: string;
  name: string;
  description: string;
  price: number;
  deliveryType: DeliveryType;
  isActive: boolean;
  stock?: number | null;
  sortOrder: number;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface TelegramUserDTO {
  id: string;
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  isBlocked: boolean;
  balance: number;
  createdAt: string;
}

export interface WalletTransactionDTO {
  id: string;
  type: WalletTransactionType;
  amount: number;
  description: string;
  paymentId?: string | null;
  createdAt: string;
}

export interface StockItemDTO {
  id: string;
  productId: string;
  content: string;
  status: StockItemStatus;
  paymentId?: string | null;
  createdAt: string;
}

export interface DeliveryLogDTO {
  id: string;
  orderId: string;
  attempt: number;
  status: DeliveryLogStatus;
  message?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface DeliveryMediaDTO {
  id: string;
  orderId: string;
  url: string;
  mediaType: DeliveryMediaType;
  caption?: string | null;
  sortOrder: number;
  createdAt: string;
}

export interface WebhookEventDTO {
  id: string;
  eventType: string;
  externalId: string;
  status: WebhookEventStatus;
  createdAt: string;
}

export interface OrderDTO {
  id: string;
  paymentId: string;
  status: OrderStatus;
  deliveredAt?: string | null;
  createdAt: string;
  deliveryLogs?: DeliveryLogDTO[];
  deliveryMedias?: DeliveryMediaDTO[];
}

export interface PaymentDTO {
  id: string;
  telegramUserId: string;
  productId: string;
  mercadoPagoId?: string | null;
  amount: number;
  status: PaymentStatus;
  pixQrCode?: string | null;
  pixQrCodeText?: string | null;
  pixExpiresAt?: string | null;
  approvedAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  /** Valor original antes de descontos */
  originalAmount?: number | null;
  /** Valor do desconto aplicado (cupom ou volume) */
  discountAmount?: number | null;
  product?: ProductDTO | null;
  telegramUser?: TelegramUserDTO | null;
  order?: OrderDTO | null;
  webhookEvents?: WebhookEventDTO[];
  stockItem?: Pick<StockItemDTO, 'content' | 'status'> | null;
}

// ─── Coupon ──────────────────────────────────────────────────────────────────

export interface CouponDTO {
  id: string;
  code: string;
  discountType: DiscountType;
  discountValue: number;
  minOrderValue?: number | null;
  maxUses?: number | null;
  usedCount: number;
  validUntil?: string | null;
  /** JSON array de productIds restritos; null = todos os produtos */
  productIds?: string[] | null;
  isActive: boolean;
  createdAt: string;
}

// ─── Referral ─────────────────────────────────────────────────────────────────

export interface ReferralDTO {
  id: string;
  referrerId: string;
  referredId: string;
  rewardPaid: boolean;
  rewardAmount: number;
  paymentId?: string | null;
  createdAt: string;
}

// ─── VolumeTier ──────────────────────────────────────────────────────────────

export interface VolumeTierDTO {
  id: string;
  /** null = tier global (todos os produtos) */
  productId?: string | null;
  minQty: number;
  discountPercent: number;
  createdAt: string;
}

// ─── Pricing result ──────────────────────────────────────────────────────────

/** Resultado do pricingService antes de criar o payment */
export interface PricingResult {
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
  /** Cupom validado (se aplicado) */
  coupon?: CouponDTO | null;
  /** Desconto de volume aplicado (%) */
  volumeDiscountPercent?: number;
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardStats {
  totalRevenue: number;
  revenueToday: number;
  revenueThisMonth: number;
  totalApproved: number;
  totalPending: number;
  totalRejected: number;
  totalExpired: number;
  totalCancelled: number;
  totalRefunded: number;
  paymentsToday: number;
  paymentsThisMonth: number;
  deliveriesFailedToday: number;
  webhooksFailedToday: number;
  ordersWithFailure: number;
}

export interface RecentPaymentItem {
  id: string;
  amount: number;
  status: PaymentStatus;
  approvedAt?: string | null;
  productName: string;
  userName: string;
}

// ─── Requests / Responses ─────────────────────────────────────────────────────

export interface CreatePaymentRequest {
  telegramId: string;
  productId: string;
  firstName?: string;
  username?: string;
  /** Método de pagamento escolhido pelo usuário. Padrão: comportamento legado (saldo automático se suficiente). */
  paymentMethod?: PaymentMethod;
  /** Código de cupom de desconto (opcional) */
  couponCode?: string;
  /** telegramId do usuário que indicou (referral, opcional) */
  referralCode?: string;
  /** Quantidade de itens (para desconto por volume). Padrão: 1 */
  quantity?: number;
}

export interface CreatePaymentResponse {
  paymentId: string;
  pixQrCode: string;       // base64 (vazio se paidWithBalance)
  pixQrCodeText: string;   // copia e cola (vazio se paidWithBalance)
  amount: number;          // valor final após descontos
  originalAmount?: number; // valor original antes de descontos
  discountAmount?: number; // valor do desconto aplicado
  pixAmount?: number;      // valor cobrado via PIX (MIXED: amount - balanceUsed)
  balanceUsed?: number;    // valor debitado do saldo (MIXED ou BALANCE)
  expiresAt: string;
  productName: string;
  paidWithBalance?: boolean; // true = 100% debitado do saldo
  isMixed?: boolean;         // true = saldo parcial + PIX pela diferença
  /** Nome do cupom aplicado (se houver) */
  couponApplied?: string;
}

export interface CreateDepositRequest {
  telegramId: string;
  amount: number;
  firstName?: string;
  username?: string;
}

export interface CreateDepositResponse {
  paymentId: string;
  pixQrCode: string;
  pixQrCodeText: string;
  amount: number;
  expiresAt: string;
}

export interface WalletBalanceResponse {
  balance: number;
  transactions: WalletTransactionDTO[];
}

export interface WalletAdjustRequest {
  amount: number;
  justification: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  details?: Array<{ field: string; message: string }>;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}
