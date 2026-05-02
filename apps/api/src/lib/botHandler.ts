// Armazena a função handleUpdate do bot registrada na inicialização.
// Isso evita import cruzado entre apps/api e apps/bot (TS6059).

type HandleUpdate = (update: object) => Promise<void>;

let _handler: HandleUpdate | null = null;

export function setBotHandler(fn: HandleUpdate): void {
  _handler = fn;
}

export function getBotHandler(): HandleUpdate | null {
  return _handler;
}
