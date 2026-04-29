// routes/admin/settings.ts
// FEAT #2 #3: Configurações do bot no painel admin + número de suporte via env var
// As configurações são armazenadas na tabela AdminSetting (chave/valor JSON) no Neon.
// Cada chave pode ser sobrescrita pela env var equivalente (Railway tem prioridade).
import { Router, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { requireRole, AuthenticatedRequest } from '../../middleware/auth';
import { logger } from '../../lib/logger';

export const adminSettingsRouter = Router();

/** Chaves de configuração perm itidas e seus defaults */
const SETTING_DEFAULTS: Record<string, string> = {
  support_phone: process.env.SUPPORT_PHONE_NUMBER ?? '',
  welcome_message: process.env.BOT_WELCOME_MESSAGE ?? 'Olhaí! Bem-vindo(a). Como posso ajudar?',
  start_message:   process.env.BOT_START_MESSAGE   ?? 'Olhá! Bem-vindo(a) à nossa loja. Digite /produtos para ver o catálogo.',
  maintenance_mode: 'false',
  maintenance_message: 'Estamos em manutenção. Voltamos em breve!',
};

const ALLOWED_KEYS = Object.keys(SETTING_DEFAULTS);

const settingsUpdateSchema = z.object({
  settings: z.record(
    z.string(),
    z.string()
  ).refine(
    (obj) => Object.keys(obj).every((k) => ALLOWED_KEYS.includes(k)),
    { message: `Chaves permitidas: ${ALLOWED_KEYS.join(', ')}` }
  ),
});

/**
 * Busca uma configuração pelo nome. Prioridade:
 * 1. Variável de ambiente (Railway tem controle total)
 * 2. Banco de dados (painel admin)
 * 3. Default hardcoded
 */
export async function getSetting(key: string): Promise<string> {
  // Mapa de env vars que sobrepõem cada chave
  const envOverrides: Record<string, string | undefined> = {
    support_phone:       process.env.SUPPORT_PHONE_NUMBER,
    welcome_message:     process.env.BOT_WELCOME_MESSAGE,
    start_message:       process.env.BOT_START_MESSAGE,
    maintenance_mode:    process.env.BOT_MAINTENANCE_MODE,
    maintenance_message: process.env.BOT_MAINTENANCE_MESSAGE,
  };

  if (envOverrides[key]) return envOverrides[key]!;

  try {
    const row = await prisma.adminSetting.findUnique({ where: { key } });
    if (row) return row.value;
  } catch {
    // Tabela pode não existir ainda na primeira execução
  }

  return SETTING_DEFAULTS[key] ?? '';
}

// GET /api/admin/settings
adminSettingsRouter.get(
  '/',
  requireRole('ADMIN', 'SUPERADMIN'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const rows = await prisma.adminSetting.findMany().catch(() => []);
      const dbMap = Object.fromEntries(rows.map((r) => [r.key, r.value]));

      // Mescla defaults + banco, retorna apenas chaves permitidas
      const result = Object.fromEntries(
        ALLOWED_KEYS.map((k) => [k, dbMap[k] ?? SETTING_DEFAULTS[k]])
      );

      res.json({ success: true, data: result });
    } catch (err) {
      logger.error('[settings] Erro ao buscar configurações:', err);
      res.status(500).json({ success: false, error: 'Erro ao buscar configurações' });
    }
  }
);

// PUT /api/admin/settings
adminSettingsRouter.put(
  '/',
  requireRole('SUPERADMIN'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { settings } = settingsUpdateSchema.parse(req.body);

      // Upsert atômico de cada chave no Neon
      await prisma.$transaction(
        Object.entries(settings).map(([key, value]) =>
          prisma.adminSetting.upsert({
            where: { key },
            update: { value },
            create: { key, value },
          })
        )
      );

      logger.info(`[settings] ${Object.keys(settings).length} configurações atualizadas por admin=${req.admin?.id}`);
      res.json({ success: true, message: 'Configurações salvas com sucesso' });
    } catch (err) {
      logger.error('[settings] Erro ao salvar configurações:', err);
      res.status(400).json({ success: false, error: err instanceof Error ? err.message : 'Erro ao salvar' });
    }
  }
);
