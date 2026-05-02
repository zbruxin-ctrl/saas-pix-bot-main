import { describe, it, expect } from 'vitest';
import { escapeMd, escapeHtml } from '../utils/escape';

describe('escapeMd', () => {
  it('escapa todos os 18 caracteres especiais do MarkdownV2', () => {
    const input = '_*[]()~`>#+-=|{}.!\\';
    const escaped = escapeMd(input);
    // cada caractere especial deve ter uma barra antes
    expect(escaped).toBe('\\_\\*\\[\\]\\(\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\');
  });

  it('não toca texto simples', () => {
    expect(escapeMd('Olá mundo')).toBe('Olá mundo');
  });

  it('converte número para string corretamente', () => {
    expect(escapeMd(42)).toBe('42');
    expect(escapeMd(3.14)).toBe('3\.14');
  });

  it('trata null e undefined como string vazia', () => {
    expect(escapeMd(null)).toBe('');
    expect(escapeMd(undefined)).toBe('');
  });

  it('escapa nome dinâmico com caracteres perigosos', () => {
    expect(escapeMd('João (da Silva)')).toBe('João \\(da Silva\\)');
    expect(escapeMd('O preço é R$ 9.99!')).toBe('O preço é R\\$ 9\\.99\\!');
  });

  it('escapa ponto — o mais frequente em valores monetários', () => {
    expect(escapeMd('R$ 29.90')).toBe('R\\$ 29\\.90');
  });
});

describe('escapeHtml', () => {
  it('escapa &, < e >', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;'
    );
  });

  it('escapa &', () => {
    expect(escapeHtml('Tom & Jerry')).toBe('Tom &amp; Jerry');
  });

  it('trata null e undefined como string vazia', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
