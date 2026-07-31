-- ============================================================
-- MusiGod CRM Schema
-- ============================================================

CREATE SCHEMA IF NOT EXISTS crm;

-- ── CONTACTS ────────────────────────────────────────────────
CREATE TABLE crm.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Identity
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  title TEXT,
  website TEXT,

  -- Categorization
  type TEXT NOT NULL CHECK (type IN (
    'artist','manager','attorney','distributor','daw_platform',
    'education','press','influencer','affiliate','partner','other'
  )),
  source TEXT CHECK (source IN (
    'cold_outreach','referral','conference','inbound','affiliate_app',
    'social','direct','other'
  )),

  -- Geography
  country TEXT,
  city TEXT,
  territory TEXT, -- e.g. 'ASCAP','PRS','GEMA','SOCAN','COSON'

  -- Status
  pipeline_stage TEXT NOT NULL DEFAULT 'identified' CHECK (pipeline_stage IN (
    'identified','contacted','responded','meeting_scheduled',
    'proposal_sent','negotiating','active','closed_won','closed_lost','on_hold'
  )),
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low','medium','high','vip')),

  -- Notes
  notes TEXT,
  tags TEXT[],

  -- Relationships
  referred_by UUID REFERENCES crm.contacts(id),
  artist_id UUID -- references artists table if they're a MusiGod user
);

-- ── PARTNERSHIPS ─────────────────────────────────────────────
CREATE TABLE crm.partnerships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  contact_id UUID NOT NULL REFERENCES crm.contacts(id) ON DELETE CASCADE,
  partner_name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN (
    'distribution','daw_tool','education','legal','press',
    'influencer','affiliate','enterprise','community','other'
  )),

  -- Deal details
  status TEXT NOT NULL DEFAULT 'prospecting' CHECK (status IN (
    'prospecting','intro_sent','in_discussion','term_sheet','active','paused','terminated'
  )),
  deal_type TEXT CHECK (deal_type IN (
    'rev_share','co_marketing','white_label','api_integration',
    'referral','sponsorship','affiliate','other'
  )),
  rev_share_pct NUMERIC(5,2),
  flat_fee NUMERIC(12,2),
  estimated_monthly_value NUMERIC(12,2),

  -- Dates
  first_contact_date DATE,
  active_since DATE,
  renewal_date DATE,

  notes TEXT,
  contract_url TEXT
);

-- ── OUTREACH LOG ─────────────────────────────────────────────
CREATE TABLE crm.outreach_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),

  contact_id UUID NOT NULL REFERENCES crm.contacts(id) ON DELETE CASCADE,
  partnership_id UUID REFERENCES crm.partnerships(id) ON DELETE SET NULL,

  channel TEXT NOT NULL CHECK (channel IN (
    'email','phone','linkedin','instagram','twitter','dm',
    'in_person','conference','referral','other'
  )),
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  subject TEXT,
  summary TEXT,
  outcome TEXT CHECK (outcome IN (
    'no_response','bounced','replied','meeting_booked',
    'declined','interested','follow_up_needed','converted'
  )),
  next_follow_up DATE,
  logged_by TEXT DEFAULT 'naim'
);

-- ── AFFILIATE PIPELINE ───────────────────────────────────────
CREATE TABLE crm.affiliate_pipeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  contact_id UUID NOT NULL REFERENCES crm.contacts(id) ON DELETE CASCADE,

  tier TEXT NOT NULL CHECK (tier IN ('tier1_artist','tier2_pro','tier3_enterprise')),
  status TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN (
    'prospect','applied','approved','active','paused','terminated'
  )),

  -- Performance
  total_referrals INT DEFAULT 0,
  active_referrals INT DEFAULT 0,
  total_earned NUMERIC(12,2) DEFAULT 0,
  last_referral_at TIMESTAMPTZ,

  -- Agreement
  agreed_terms_at TIMESTAMPTZ,
  affiliate_code TEXT UNIQUE,
  payout_email TEXT,
  notes TEXT
);

-- ── UPDATED_AT TRIGGERS ──────────────────────────────────────
CREATE OR REPLACE FUNCTION crm.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON crm.contacts
  FOR EACH ROW EXECUTE FUNCTION crm.set_updated_at();

CREATE TRIGGER partnerships_updated_at
  BEFORE UPDATE ON crm.partnerships
  FOR EACH ROW EXECUTE FUNCTION crm.set_updated_at();

CREATE TRIGGER affiliate_pipeline_updated_at
  BEFORE UPDATE ON crm.affiliate_pipeline
  FOR EACH ROW EXECUTE FUNCTION crm.set_updated_at();

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX idx_contacts_type ON crm.contacts(type);
CREATE INDEX idx_contacts_stage ON crm.contacts(pipeline_stage);
CREATE INDEX idx_contacts_priority ON crm.contacts(priority);
CREATE INDEX idx_contacts_country ON crm.contacts(country);
CREATE INDEX idx_outreach_contact ON crm.outreach_log(contact_id);
CREATE INDEX idx_outreach_follow_up ON crm.outreach_log(next_follow_up);
CREATE INDEX idx_partnerships_status ON crm.partnerships(status);
CREATE INDEX idx_affiliate_status ON crm.affiliate_pipeline(status);

-- ── PIPELINE SUMMARY VIEW ────────────────────────────────────
CREATE OR REPLACE VIEW crm.pipeline_summary AS
SELECT
  c.pipeline_stage,
  c.type,
  COUNT(*) AS contact_count,
  COUNT(p.id) AS partnership_count,
  COALESCE(SUM(p.estimated_monthly_value), 0) AS pipeline_value_monthly
FROM crm.contacts c
LEFT JOIN crm.partnerships p ON p.contact_id = c.id
GROUP BY c.pipeline_stage, c.type
ORDER BY c.pipeline_stage, c.type;

-- ── OUTREACH DUE TODAY VIEW ──────────────────────────────────
CREATE OR REPLACE VIEW crm.follow_ups_due AS
SELECT
  ol.next_follow_up,
  c.full_name,
  c.email,
  c.type,
  c.company,
  c.pipeline_stage,
  ol.subject,
  ol.outcome AS last_outcome,
  ol.channel AS last_channel,
  ol.id AS log_id,
  c.id AS contact_id
FROM crm.outreach_log ol
JOIN crm.contacts c ON c.id = ol.contact_id
WHERE ol.next_follow_up <= CURRENT_DATE + INTERVAL '7 days'
  AND ol.next_follow_up >= CURRENT_DATE
ORDER BY ol.next_follow_up ASC;

-- ── SEED: KEY PARTNERSHIP TARGETS ───────────────────────────
INSERT INTO crm.contacts (full_name, company, type, source, pipeline_stage, priority, country, notes, tags) VALUES
('DistroKid Partnerships','DistroKid','distributor','cold_outreach','identified','vip','US','2M+ artist user base. Co-marketing email blast target. In-app upsell integration.',ARRAY['distribution','tier1']),
('TuneCore Business Dev','TuneCore','distributor','cold_outreach','identified','vip','US','In-app publishing admin upsell widget opportunity.',ARRAY['distribution','tier1']),
('CD Baby / Downtown','Downtown Music Holdings','distributor','cold_outreach','identified','vip','US','White-label admin services for Pro Unlimited tier.',ARRAY['distribution','tier1']),
('Audiomack Partnerships','Audiomack','distributor','cold_outreach','identified','high','US','Largest Afrobeats creator base outside Lagos. Africa market entry.',ARRAY['distribution','africa','tier1']),
('UnitedMasters BD','UnitedMasters','distributor','cold_outreach','identified','high','US','Steve Stoute''s platform. Brand-deals-first model pairs perfectly with royalty recovery.',ARRAY['distribution','tier1']),
('BeatStars Partnerships','BeatStars','daw_platform','cold_outreach','identified','vip','US','3M+ producers. In-platform publishing admin integration.',ARRAY['daw','beatmakers','tier1']),
('Splice Business Dev','Splice','daw_platform','cold_outreach','identified','high','US','4M+ creators. Sample licensing community needs publishing admin.',ARRAY['daw','tier1']),
('LANDR Partnerships','LANDR','daw_platform','cold_outreach','identified','high','Canada','2M+ creators. AI mastering + MusiGod publishing = complete indie stack.',ARRAY['daw','canada','tier2']),
('Music Business Worldwide','MBW','press','cold_outreach','identified','vip','UK','Largest music trade readership. Pitch: indie admin revolution angle.',ARRAY['press','tier1']),
('Hypebot Editor','Hypebot','press','cold_outreach','identified','high','US','Indie music industry daily read. Startup-friendly coverage.',ARRAY['press','tier1']),
('Trapital - Dan Runcie','Trapital','press','cold_outreach','identified','vip','US','Hip-hop business analysis podcast. Perfect demographic alignment.',ARRAY['press','podcast','tier1']),
('Berklee Online Partnerships','Berklee College of Music','education','cold_outreach','identified','high','US','Co-develop Music Business & Publishing Admin certificate module.',ARRAY['education','tier2']),
('NMBA Executive Director','National Music Bar Association','legal','cold_outreach','identified','high','US','Music attorney referral network. $200/activation + white-glove onboarding.',ARRAY['legal','attorneys','tier1']),
('A2IM Membership','A2IM','partner','cold_outreach','identified','high','US','American Association of Independent Music. 700+ indie label members.',ARRAY['association','labels','tier2']),
('WIN Global','Worldwide Independent Network','partner','cold_outreach','identified','high','UK','1,200+ indie labels globally. International market entry vehicle.',ARRAY['association','international','tier1']);
