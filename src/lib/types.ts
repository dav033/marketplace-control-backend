export type ProviderStatus = 'candidate' | 'under_review' | 'approved' | 'rejected' | 'archived';
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
};

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
  email: string;
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
