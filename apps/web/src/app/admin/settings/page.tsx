'use client';

import { useState, useEffect, useCallback } from 'react';

interface BotSettings {
  supportPhone: string;
  welcomeMessage: string;
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

const DEFAULTS: BotSettings = {
  supportPhone: '',
  welcomeMessage: '',
  maintenanceMode: false,
  maintenanceMessage: '⚙️ O bot está em manutenção. Voltamos em breve!',
};

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-red-500' : 'bg-gray-200'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<BotSettings>(DEFAULTS);
  const [original, setOriginal] = useState<BotSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);

  function showToast(msg: string, type: 'success' | 'error') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/settings', { credentials: 'include' });
      const data = await res.json();
      if (data.success && data.data) {
        const merged = { ...DEFAULTS, ...data.data };
        setSettings(merged);
        setOriginal(merged);
      }
    } catch {
      //
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function set<K extends keyof BotSettings>(key: K, value: BotSettings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  const isDirty = JSON.stringify(settings) !== JSON.stringify(original);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Erro ao salvar');
      setOriginal(settings);
      showToast('Configurações salvas com sucesso', 'success');
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Erro ao salvar', 'error');
    } finally {
      setSaving(false);
    }
  }

  function handleDiscard() {
    setSettings(original);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Configurações</h1>
        </div>
        <div className="card flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Configurações</h1>
        <p className="text-gray-500 text-sm mt-1">
          Gerencie as configurações do bot sem precisar fazer novo deploy
        </p>
      </div>

      {/* Toast */}
      {toast && (
        <div
          className={`rounded-xl border px-4 py-3 text-sm flex items-center gap-3 ${
            toast.type === 'success'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
        >
          <span className="text-lg">{toast.type === 'success' ? '✅' : '❌'}</span>
          {toast.msg}
        </div>
      )}

      {/* Card principal */}
      <div className="card space-y-6">

        {/* Modo Manutenção */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">Modo Manutenção</p>
              <p className="text-sm text-gray-500 mt-0.5">
                Bloqueia novas compras e exibe aviso de manutenção aos usuários
              </p>
            </div>
            <Toggle
              checked={settings.maintenanceMode}
              onChange={(v) => set('maintenanceMode', v)}
            />
          </div>

          {settings.maintenanceMode && (
            <div className="ml-0 space-y-1">
              <label className="block text-sm font-medium text-gray-700">
                Mensagem exibida durante a manutenção
              </label>
              <textarea
                className="input w-full min-h-[80px] resize-y text-sm"
                value={settings.maintenanceMessage}
                onChange={(e) => set('maintenanceMessage', e.target.value)}
                placeholder="⚙️ Bot em manutenção. Voltamos em breve!"
              />
            </div>
          )}
        </div>

        <div className="border-t border-gray-100" />

        {/* Suporte */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">
            Número de Suporte (WhatsApp)
          </label>
          <p className="text-sm text-gray-500">
            Número exibido no botão "Falar com suporte" do bot
          </p>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-sm text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 select-none whitespace-nowrap">
              wa.me/
            </span>
            <input
              className="input flex-1"
              placeholder="5511999999999"
              value={settings.supportPhone}
              onChange={(e) =>
                set('supportPhone', e.target.value.replace(/\D/g, ''))
              }
            />
          </div>
          {settings.supportPhone && (
            <p className="text-xs text-blue-600 mt-1">
              Link gerado:{' '}
              <a
                href={`https://wa.me/${settings.supportPhone}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-blue-800"
              >
                wa.me/{settings.supportPhone}
              </a>
            </p>
          )}
          <p className="text-xs text-gray-400">
            Somente números com DDI. Ex: <code className="bg-gray-100 px-1 rounded">5511999999999</code>
          </p>
        </div>

        <div className="border-t border-gray-100" />

        {/* Boas-vindas */}
        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-gray-900">
            Mensagem de Boas-vindas
          </label>
          <p className="text-sm text-gray-500">
            Exibida quando o usuário inicia o bot pela primeira vez com <code className="bg-gray-100 px-1 rounded text-xs">/start</code>
          </p>
          <textarea
            className="input w-full min-h-[120px] resize-y text-sm mt-2"
            placeholder="Olá, {nome}! 👋 Bem-vindo ao nosso bot.\nUse /produtos para ver o catálogo."
            value={settings.welcomeMessage}
            onChange={(e) => set('welcomeMessage', e.target.value)}
          />
          <p className="text-xs text-gray-400">
            Use{' '}
            <code className="bg-gray-100 px-1 rounded">{'{nome}'}</code>{' '}para o primeiro nome do usuário.{' '}
            Suporta Markdown do Telegram: <code className="bg-gray-100 px-1 rounded">*negrito*</code>,{' '}
            <code className="bg-gray-100 px-1 rounded">_itálico_</code>
          </p>
        </div>

        {/* Ações */}
        <div className="flex items-center justify-end gap-3 pt-3 border-t border-gray-100">
          {isDirty && (
            <button
              onClick={handleDiscard}
              disabled={saving}
              className="btn-secondary text-sm"
            >
              Descartar alterações
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="btn-primary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <span className="animate-spin rounded-full h-4 w-4 border-b-2 border-white inline-block" />
                Salvando...
              </span>
            ) : (
              '💾 Salvar configurações'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
