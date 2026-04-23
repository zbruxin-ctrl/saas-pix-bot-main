// Tipos compartilhados entre todos os apps do monorepo

export type PaymentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'REFUNDED';
export type DeliveryType = 'TEXT' | 'LINK' | 'TOKEN' | 'ACCOUNT';
export type OrderStatus = 'PROCESSING' | 'DELIVERED' | 'FAILED';
export type AdminRole = 'SUPER_ADMIN' | 'ADMIN' | 'OPERATOR';

export interface ProductDTO {
  id: string;
  name: string;
  description: string;
  price: number;
  deliveryType: DeliveryType;
  isActive: boolean;
  stock?: number | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
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
  createdAt: string;
  product?: ProductDTO;
  telegramUser?: TelegramUserDTO;
}

export interface TelegramUserDTO {
  id: string;
  telegramId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  createdAt: string;
}

export interface DashboardStats {
  totalRevenue: number;
  totalApproved: number;
  totalPending: number;
  totalRejected: number;
  revenueToday: number;
  paymentsToday: number;
  revenueThisMonth: number;
  paymentsThisMonth: number;
}

export interface CreatePaymentRequest {
  telegramId: string;
  productId: string;
  firstName?: string;
  username?: string;
}

export interface CreatePaymentResponse {
  paymentId: string;
  pixQrCode: string;      // base64
  pixQrCodeText: string;  // copia e cola
  amount: number;
  expiresAt: string;
  productName: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}
