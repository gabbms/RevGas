// Ícones de contorno 16px (traço 1.5), um conjunto só. Desenhados aqui para não depender de biblioteca.
const svg = (d: string, extra = ''): string =>
  `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;

export const ICONS = {
  pedidos: svg('<rect x="3" y="2.5" width="10" height="11.5" rx="1.5"/><path d="M6 2.5v-1h4v1M5.5 6.5h5M5.5 9h5M5.5 11.5h3"/>'),
  clientes: svg('<circle cx="6" cy="5.5" r="2.25"/><path d="M1.75 13.5c.5-2.4 2.2-3.75 4.25-3.75s3.75 1.35 4.25 3.75"/><path d="M10.5 3.4a2.2 2.2 0 0 1 0 4.2M12 9.9c1.2.5 2 1.6 2.25 3.6"/>'),
  conversas: svg('<path d="M2.5 3.5h11v7.5h-6l-3 2.5V11h-2z"/>'),
  alertas: svg('<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3z"/><path d="M6.5 14a1.6 1.6 0 0 0 3 0"/>'),
  config: svg('<path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/>'),
  sair: svg('<path d="M9.5 3H13v10H9.5M6.5 5 3.5 8l3 3M3.5 8h7"/>'),
  audio: svg('<rect x="5.75" y="2" width="4.5" height="7.5" rx="2.25"/><path d="M3.5 8a4.5 4.5 0 0 0 9 0M8 12.5V14"/>'),
  mais: svg('<circle cx="3.5" cy="8" r=".75" fill="currentColor"/><circle cx="8" cy="8" r=".75" fill="currentColor"/><circle cx="12.5" cy="8" r=".75" fill="currentColor"/>'),
  voltar: svg('<path d="M10 3 5 8l5 5"/>'),
} as const;

/** A marca: um botijão P13 de frente (alça, ombro e corpo), na cor de destaque. */
export const MARCA = `<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true"><rect width="28" height="28" rx="7" fill="var(--accent)"/><path d="M10.5 5.5h7v3.5h-7z" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 13.2c0-2.6 2.2-4.2 6-4.2s6 1.6 6 4.2v8.3c0 .8-.6 1.5-1.4 1.5H9.4c-.8 0-1.4-.7-1.4-1.5z" fill="#fff"/><path d="M8 16.5h12" stroke="var(--accent)" stroke-width="1.2"/></svg>`;
