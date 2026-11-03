// Ícones de contorno 16px (traço 1.5), um conjunto só. Desenhados aqui para não depender de biblioteca.
const svg = (d: string, extra = ''): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICONS = {
  pedidos: svg('<rect x="3" y="2.5" width="10" height="11.5" rx="1.5"/><path d="M6 2.5v-1h4v1M5.5 6.5h5M5.5 9h5M5.5 11.5h3"/>'),
  clientes: svg('<circle cx="6" cy="5.5" r="2.25"/><path d="M1.75 13.5c.5-2.4 2.2-3.75 4.25-3.75s3.75 1.35 4.25 3.75"/><path d="M10.5 3.4a2.2 2.2 0 0 1 0 4.2M12 9.9c1.2.5 2 1.6 2.25 3.6"/>'),
  conversas: svg('<path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z"/>'),
  alertas: svg('<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/>'),
  config: svg('<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>'),
  central: svg('<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><rect x="9" y="9" width="4.5" height="4.5" rx="1"/>'),
  atendente: svg('<path d="M3 9.5V8a5 5 0 0 1 10 0v1.5"/><rect x="2" y="9" width="2.5" height="3.5" rx="1"/><rect x="11.5" y="9" width="2.5" height="3.5" rx="1"/><path d="M13 12.5c0 1-1 1.5-2.5 1.5H9"/>'),
  sino: svg('<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/>'),
  relogio: svg('<circle cx="8" cy="8.5" r="5.5"/><path d="M8 5.5v3l2 1.5M6.5 1.5h3"/>'),
  check: svg('<circle cx="8" cy="8" r="6"/><path d="m5.5 8.2 1.7 1.7 3.3-3.6"/>'),
  tema: svg('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none"/>'),
  recolher: svg('<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M6 3v10M11 6.5 9.5 8l1.5 1.5"/>'),
  chama: '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8.6 1c.3 2.3-.6 3.5-1.7 4.7C5.7 7 4.5 8.2 4.5 10.2 4.5 12.9 6.3 15 8.5 15s3.9-1.9 3.9-4.5c0-1.4-.5-2.5-1.1-3.4-.2.8-.7 1.4-1.3 1.7C10.200 6 9.9 3 8.600 1z"/></svg>',
  moto: svg('<circle cx="3.5" cy="11.5" r="2"/><circle cx="12.5" cy="11.5" r="2"/><path d="m3.5 11.5 2.5-5.5h3l2 3.5h1.5M9 6V4h2"/>'),
  dinheiro: svg('<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><circle cx="8" cy="8" r="1.75"/>'),
  cartao: svg('<rect x="1.5" y="3.5" width="13" height="9" rx="1.5"/><path d="M1.5 6.5h13M4 10h2.5"/>'),
  pix: svg('<path d="M8 1.8 12.3 6.1a2.7 2.7 0 0 1 0 3.8L8 14.2 3.7 9.9a2.7 2.7 0 0 1 0-3.8z"/><path d="M5.5 8h5"/>'),
  loja: svg('<path d="M2.5 7v6.5h11V7M1.5 6.5 3 2.5h10l1.5 4a1.9 1.9 0 0 1-3.2 1.2 1.9 1.9 0 0 1-3.3 0 1.9 1.9 0 0 1-3.3 0A1.9 1.9 0 0 1 1.5 6.5z"/>'),
  x: svg('<path d="m3.5 3.5 9 9M12.5 3.5l-9 9"/>'),
  mapa: svg('<path d="M8 14.5s4.5-4.2 4.5-7.8a4.5 4.5 0 0 0-9 0C3.5 10.300 8 14.500 8 14.500z"/><circle cx="8" cy="6.700" r="1.5"/>'),
  sair: svg('<path d="M9.5 3H13v10H9.5M6.5 5 3.5 8l3 3M3.5 8h7"/>'),
  audio: svg('<rect x="5.75" y="2" width="4.5" height="7.5" rx="2.25"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14"/>'),
  mais: svg('<circle cx="3.5" cy="8" r=".75" fill="currentColor"/><circle cx="8" cy="8" r=".75" fill="currentColor"/><circle cx="12.5" cy="8" r=".75" fill="currentColor"/>'),
  voltar: svg('<path d="M10 3 5 8l5 5"/>'),
} as const;

/** A marca: um botijão P13 de frente (alça, ombro e corpo), na cor de destaque. */
export const MARCA = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><rect width="28" height="28" rx="7" fill="var(--accent)"/><path d="M10.5 5.5h7v3.5h-7z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 13.2c0-2.6 2.2-4.2 6-4.2s6 1.6 6 4.2v8.3c0 .8-.6 1.5-1.4 1.5H9.4c-.8 0-1.4-.7-1.4-1.5z" fill="#fff"/><path d="M8 16.5h12" stroke="var(--accent)" stroke-width="1.2"/></svg>`;
