import type { DashboardData, Provider, Registration } from './types';

const providers: Provider[] = [
  {
    provider_id: 'demo-1', display_name: 'Muestra: Banquetes del Norte', category: 'Comida y bebida', city: 'Barranquilla',
    rating: 4.8, review_count: 42, contact_channel: 'whatsapp', phone: '+57 300 1234567', status: 'candidate', discovery_source: 'Prompt v2.8 · muestra', contact_email: null, last_activity: 'Ayer', platform_count: 2, additional_categories: ['Entretenimiento'],
  },
  {
    provider_id: 'demo-2', display_name: 'Muestra: Estudio Luz Caribe', category: 'Fotografía', city: 'Barranquilla',
    rating: 4.7, review_count: 31, contact_channel: 'whatsapp', phone: '+57 300 1234567', status: 'under_review', discovery_source: 'Prompt v2.8 · muestra', contact_email: 'pendiente', last_activity: 'Hace 2 días', platform_count: 1, additional_categories: [],
  },
  {
    provider_id: 'demo-3', display_name: 'Muestra: Sonido Patio', category: 'Música', city: 'Medellín',
    rating: 4.9, review_count: 87, contact_channel: 'email', phone: '+57 300 1234567', status: 'approved', discovery_source: 'Prompt v2.8 · muestra', contact_email: 'registrado', last_activity: 'Hace 4 días', platform_count: 1, additional_categories: [],
  },
  {
    provider_id: 'demo-4', display_name: 'Muestra: Salón La Estación', category: 'Venues', city: 'Bogotá',
    rating: 4.6, review_count: 119, contact_channel: 'whatsapp', phone: '+57 300 1234567', status: 'candidate', discovery_source: 'Prompt v2.8 · muestra', contact_email: null, last_activity: 'Hace 5 días', platform_count: 3, additional_categories: ['Comida y Bebida', 'Entretenimiento'],
  },
];

const registrations: Registration[] = [
  {
    submission_id: 'demo-form-1', provider_id: 'demo-3', company_name: 'Muestra: Sonido Patio', full_name: 'Contacto de muestra',
    email: 'demo@example.com', submission_status: 'new', created_at: 'Hoy, 09:42',
  },
];

export function demoDashboard(): DashboardData {
  return {
    counts: { candidates: 18, contacted: 7, interested: 3, submissions: 1 },
    providers,
    registrations,
    connected: false,
  };
}

export function demoProvider(id: string) {
  const provider = providers.find((provider) => provider.provider_id === id) ?? providers[0];
  return {
    ...provider,
    sources: provider.rating
      ? [{ source_name: 'Google', observed_rating: provider.rating, observed_reviews: provider.review_count, source_url: null }]
      : [],
  };
}
