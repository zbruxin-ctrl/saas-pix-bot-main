// Carrega variáveis de ambiente da raiz do projeto
import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(__dirname, '../.env') });

// Script de seed: cria dados iniciais no banco
import { PrismaClient, DeliveryType, AdminRole } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Iniciando seed do banco de dados...');

  // Cria usuário admin padrão
  const passwordHash = await bcrypt.hash(process.env.ADMIN_DEFAULT_PASSWORD || 'Admin@123456', 12);

  const admin = await prisma.adminUser.upsert({
    where: { email: 'admin@seusite.com.br' },
    update: {},
    create: {
      email: 'admin@seusite.com.br',
      passwordHash,
      name: 'Administrador',
      role: AdminRole.SUPER_ADMIN,
    },
  });

  console.log(`✅ Admin criado: ${admin.email}`);

  // Cria produtos de exemplo
  const products = await Promise.all([
    prisma.product.upsert({
      where: { id: 'prod_basico' },
      update: {},
      create: {
        id: 'prod_basico',
        name: '🥉 Plano Básico',
        description: 'Acesso por 30 dias à plataforma com recursos essenciais',
        price: 29.90,
        deliveryType: DeliveryType.TEXT,
        deliveryContent: '✅ Seu acesso foi liberado!\n\n🔑 *Login:* usuario_teste\n🔑 *Senha:* senha_teste_123\n\nAcesse: https://seusite.com.br/login\n\nEm caso de dúvidas, entre em contato.',
        isActive: true,
        metadata: { days: 30, features: ['básico'] },
      },
    }),
    prisma.product.upsert({
      where: { id: 'prod_pro' },
      update: {},
      create: {
        id: 'prod_pro',
        name: '🥈 Plano Pro',
        description: 'Acesso por 30 dias com recursos avançados e suporte prioritário',
        price: 59.90,
        deliveryType: DeliveryType.LINK,
        deliveryContent: 'https://seusite.com.br/acesso?token=TOKEN_AQUI',
        isActive: true,
        metadata: { days: 30, features: ['básico', 'avançado', 'suporte'] },
      },
    }),
    prisma.product.upsert({
      where: { id: 'prod_premium' },
      update: {},
      create: {
        id: 'prod_premium',
        name: '🥇 Plano Premium',
        description: 'Acesso vitalício com todos os recursos e suporte VIP',
        price: 197.00,
        deliveryType: DeliveryType.ACCOUNT,
        deliveryContent: JSON.stringify({
          message: '🎉 Bem-vindo ao Plano Premium!',
          accessUrl: 'https://seusite.com.br/premium',
          instructions: 'Use seu e-mail do Telegram para fazer login.',
        }),
        isActive: true,
        metadata: { lifetime: true, features: ['todos', 'vip'] },
      },
    }),
  ]);

  console.log(`✅ ${products.length} produtos criados`);
  console.log('\n🎉 Seed concluído com sucesso!');
  console.log('\n📋 Credenciais admin padrão:');
  console.log('   Email: admin@seusite.com.br');
  console.log('   Senha: Admin@123456');
  console.log('\n⚠️  ALTERE A SENHA APÓS O PRIMEIRO LOGIN!');
}

main()
  .catch((e) => {
    console.error('❌ Erro no seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
