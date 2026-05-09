// kycLogStore.ts
// Store em memória para logs do KYC detector.
// Mantém os últimos MAX_LOGS eventos (Socure ou Veriff) para exibição no painel admin.
// Em produção, se quiser persistência, troque por prisma.kycLog.create().

export type KycProvider = 'socure' | 'veriff' | 'unknown';

export interface KycLogEntry {
  id: string;
  provider: KycProvider;
  event: string;          // ex: "DOCUMENTS_UPLOADED", "DECISION_UPDATE"
  status: string;         // ex: "approved", "declined", "pending"
  referenceId: string;    // ID do usuário/sessão no provedor
  rawPayload: unknown;
  receivedAt: string;     // ISO string
}

const MAX_LOGS = 200;
const store: KycLogEntry[] = [];
let counter = 0;

export function appendKycLog(entry: Omit<KycLogEntry, 'id' | 'receivedAt'>): KycLogEntry {
  const log: KycLogEntry = {
    ...entry,
    id: `kyc_${Date.now()}_${++counter}`,
    receivedAt: new Date().toISOString(),
  };
  store.unshift(log); // mais recente primeiro
  if (store.length > MAX_LOGS) store.splice(MAX_LOGS);
  return log;
}

export function getKycLogs(limit = 50, provider?: KycProvider): KycLogEntry[] {
  const filtered = provider ? store.filter((l) => l.provider === provider) : store;
  return filtered.slice(0, limit);
}

export function clearKycLogs(): void {
  store.splice(0);
}
