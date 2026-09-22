export type ProviderStatus = 'candidate' | 'unconfirmed' | 'under_review' | 'approved' | 'rejected' | 'archived';
export type ContactChannel = 'email' | 'whatsapp';

export type Provider = {
  provider_id: string;
  display_name: string;
  category: string;
  city: string;
  rating: number | null;
  review_count: number | null;
  contact_channel: ContactChannel;
  phone: string | null;
  status: ProviderStatus;
  discovery_source: string | null;
  contact_email: string | null;
  last_activity: string | null;
  platform_count: number;
  additional_categories: string[];
  /** En qué punto está el contacto por WhatsApp; null = nunca se le escribió. */
  whatsapp_status?: WhatsappStatus | null;
  /** Cuándo cambió por última vez, ya formateado ("22 Sep, 16:44"). */
  whatsapp_status_at?: string | null;
  whatsapp_status_reason?: string | null;
};

/** Estados del contacto por WhatsApp. Las transiciones viven en `conversation-status.ts`. */
export type WhatsappStatus =
  | 'mensaje_enviado'
  | 'conversacion_iniciada'
  | 'conversacion_aceptada'
  | 'conversacion_rechazada'
  | 'rechazado'
  | 'inscrito';

export type ProviderSource = {
  source_name: string;
  observed_rating: number | null;
  observed_reviews: number | null;
  source_url: string | null;
};

export type Registration = {
  submission_id: string;
  provider_id: string | null;
  company_name: string | null;
  full_name: string | null;
  /** Puede faltar en fichas que llegan por WhatsApp: el número ya es el canal de contacto. */
  email: string | null;
  submission_status: string;
  created_at: string;
};

export type DashboardData = {
  counts: {
    candidates: number;
    contacted: number;
    interested: number;
    submissions: number;
  };
  providers: Provider[];
  registrations: Registration[];
  connected: boolean;
};
