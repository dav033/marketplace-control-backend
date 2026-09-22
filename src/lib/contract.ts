/**
 * Contrato entre el frontend y el backend.
 *
 * Todo lo que cruza la frontera vive aquí: las formas de las respuestas de `/api/v1/*` y las
 * constantes que ambos lados necesitan conocer. Es el único módulo que los dos importan, y no
 * depende de `pg`, de `node:crypto` ni de nada del servidor — si algo de eso se colara, el frontend
 * dejaría de poder construirse para Vercel.
 */
export type { ContactChannel, DashboardData, Provider, ProviderSource, ProviderStatus, Registration } from './types';

/** Cabecera con la que el frontend se identifica ante el backend. */
export const SERVICE_TOKEN_HEADER = 'x-service-token';

/**
 * Número de WhatsApp de Happia (sin "+", como lo pide wa.me), para abrir una conversación de
 * prueba hacia el negocio desde el panel — no es un secreto, es el mismo número público que
 * cualquiera puede encontrar en el perfil de WhatsApp Business.
 */
export const HAPPIA_WHATSAPP_NUMBER = '573107346405';

// Las categorías que puede marcar el proveedor son las mismas 10 de la curaduría: si aquí
// apareciera una etiqueta libre, la ficha resultante no podría cruzarse con el resto del sistema.
export const REGISTRATION_CATEGORIES = [
  'Lugar', 'Comida y Bebida', 'Música', 'Servicios Especializados', 'Entretenimiento',
  'Decoración temática', 'Fotografía y Video', 'Invitación digital', 'Menaje y mantelería', 'Carpas y mobiliario',
];

export type RegistrationLinkState = 'valid' | 'expired' | 'submitted' | 'unknown';

export type RegistrationLink = {
  providerName: string;
  linkState: RegistrationLinkState;
  /** ISO 8601, o null. Es texto y no `Date` porque cruza HTTP. */
  submittedAt: string | null;
  categories: string[];
};

export type CampaignSummary = {
  campaign_id: string;
  name: string;
  subject: string;
  status: string;
  sender_email: string;
  created_at: string;
  recipients: number;
  sent: number;
  failed: number;
  clicked: number;
  forms: number;
  omnisend_campaign_id: string | null;
};

export type CampaignRecipient = {
  provider_id: string;
  contact_id: string | null;
  display_name: string;
  category: string;
  city: string;
  status: string;
  contact_channel: 'email' | 'whatsapp';
  phone: string | null;
  email: string | null;
  full_name: string | null;
  consent_status: 'unknown' | 'granted' | 'revoked' | null;
  email_eligible: boolean;
};

export type CampaignOverview = {
  connected: boolean;
  campaigns: CampaignSummary[];
  recipients: CampaignRecipient[];
  /** Listas ya ordenadas para los selectores: el front no deriva nada del lote. */
  cities: string[];
  statuses: string[];
  categories: string[];
  defaultSender: string;
  omnisendReady: boolean;
  qaRecipientsLabel: string;
  /** Cuántos destinatarios pueden recibir correo hoy: consentimiento concedido y sin supresión. */
  emailEligibleCount: number;
  qaRecipientsCount: number;
};

/** Un proveedor preregistrado junto con la respuesta que dio. */
export type Preregistered = {
  provider_id: string;
  display_name: string;
  city: string | null;
  category: string | null;
  rating: number | null;
  review_count: number | null;
  submission_id: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  company_name: string | null;
  products: string[];
  services: string[];
  volume_min: number | null;
  volume_max: number | null;
  marketing_consent: boolean;
  consent_source: string | null;
  description: string | null;
  submitted_at: string | null;
};
