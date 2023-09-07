ALTER TABLE public.profiles
ADD COLUMN subscription_end_date TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.profiles
ADD COLUMN subscription_id TEXT UNIQUE;
ALTER TABLE public.profiles
ADD COLUMN stripe_id TEXT UNIQUE;
ALTER TABLE public.profiles
ADD COLUMN pro_trial_count INTEGER DEFAULT 0 NOT NULL;