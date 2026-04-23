// Serviço de entrega - responsável por entregar o produto após pagamento confirmado
import { DeliveryType, TelegramUser, Product } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { telegramService } from './telegramService';
import { logger } from '../lib/logger';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

class DeliveryService {

  // Entrega o produto ao usuário via Telegram
  async deliver(
    orderId: string,
    telegramUser: TelegramUser,
    product: Product
  ): Promise<void> {
    logger.info(`Iniciando entrega do pedido ${orderId}`);

    let attempt = 0;
    let lastError: string | null = null;

    while (attempt < MAX_RETRIES) {
      attempt++;

      try {
        await this.executeDelivery(telegramUser.telegramId, product);

        // Sucesso: atualiza pedido e cria log
        await prisma.$transaction([
          prisma.order.update({
            where: { id: orderId },
            data: { status: 'DELIVERED', deliveredAt: new Date() },
          }),
          prisma.deliveryLog.create({
            data: {
              orderId,
              attempt,
              status: 'SUCCESS',
              message: `Entrega realizada com sucesso via ${product.deliveryType}`,
            },
          }),
        ]);

        logger.info(`Pedido ${orderId} entregue com sucesso na tentativa ${attempt}`);
        return;

      } catch (error) {
        lastError = error instanceof Error ? error.message : 'Erro desconhecido';

        logger.error(`Tentativa ${attempt}/${MAX_RETRIES} falhou para pedido ${orderId}:`, error);

        // Cria log de falha
        await prisma.deliveryLog.create({
          data: {
            orderId,
            attempt,
            status: attempt < MAX_RETRIES ? 'RETRYING' : 'FAILED',
            error: lastError,
          },
        });

        if (attempt < MAX_RETRIES) {
          // Aguarda antes de tentar novamente
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }

    // Todas as tentativas falharam
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'FAILED' },
    });

    // Notifica admin sobre falha na entrega
    logger.error(`CRÍTICO: Entrega do pedido ${orderId} falhou após ${MAX_RETRIES} tentativas. Erro: ${lastError}`);

    // Tenta notificar o usuário sobre o problema
    try {
      await telegramService.sendDeliveryError(telegramUser.telegramId);
    } catch {
      logger.error(`Não foi possível notificar usuário ${telegramUser.telegramId} sobre falha na entrega`);
    }
  }

  // Executa a entrega conforme o tipo do produto
  private async executeDelivery(
    telegramId: string,
    product: Product
  ): Promise<void> {
    switch (product.deliveryType) {
      case DeliveryType.TEXT:
        await this.deliverText(telegramId, product.deliveryContent, product.name);
        break;

      case DeliveryType.LINK:
        await this.deliverLink(telegramId, product.deliveryContent, product.name);
        break;

      case DeliveryType.TOKEN:
        await this.deliverToken(telegramId, product.deliveryContent, product.name);
        break;

      case DeliveryType.ACCOUNT:
        await this.deliverAccount(telegramId, product.deliveryContent, product.name);
        break;

      default:
        throw new Error(`Tipo de entrega desconhecido: ${product.deliveryType}`);
    }
  }

  // Entrega mensagem de texto simples
  private async deliverText(
    telegramId: string,
    content: string,
    productName: string
  ): Promise<void> {
    const message = `🎉 *Pagamento confirmado!*\n\n📦 *Produto:* ${productName}\n\n${content}`;
    await telegramService.sendMessage(telegramId, message);
  }

  // Entrega link de acesso
  private async deliverLink(
    telegramId: string,
    link: string,
    productName: string
  ): Promise<void> {
    const message =
      `🎉 *Pagamento confirmado!*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      `🔗 Acesse através do link abaixo:\n${link}\n\n` +
      `⚠️ _Guarde este link em local seguro._`;
    await telegramService.sendMessage(telegramId, message);
  }

  // Entrega token/chave de ativação
  private async deliverToken(
    telegramId: string,
    token: string,
    productName: string
  ): Promise<void> {
    const message =
      `🎉 *Pagamento confirmado!*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      `🔑 *Seu token de ativação:*\n\`${token}\`\n\n` +
      `⚠️ _Não compartilhe este token com ninguém._`;
    await telegramService.sendMessage(telegramId, message);
  }

  // Entrega dados de conta/acesso
  private async deliverAccount(
    telegramId: string,
    content: string,
    productName: string
  ): Promise<void> {
    let parsedContent: Record<string, unknown>;

    try {
      parsedContent = JSON.parse(content);
    } catch {
      // Se não for JSON, trata como texto
      await this.deliverText(telegramId, content, productName);
      return;
    }

    const message =
      `🎉 *${parsedContent.message || 'Acesso liberado!'}*\n\n` +
      `📦 *Produto:* ${productName}\n\n` +
      (parsedContent.accessUrl ? `🌐 *URL de acesso:* ${parsedContent.accessUrl}\n\n` : '') +
      (parsedContent.instructions ? `📋 *Instruções:* ${parsedContent.instructions}\n\n` : '') +
      `⚠️ _Salve estas informações em local seguro._`;

    await telegramService.sendMessage(telegramId, message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const deliveryService = new DeliveryService();
