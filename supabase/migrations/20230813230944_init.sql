CREATE TABLE debates (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid NOT NULL,
    topic TEXT NOT NULL,
    short_topic TEXT NOT NULL,
    persona TEXT NOT NULL,
    model TEXT NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TYPE speaker_type AS ENUM ('user', 'AI', 'AI_for_user');
CREATE TABLE turns (
    id uuid NOT NULL DEFAULT uuid_generate_v4() PRIMARY KEY,
    user_id uuid NOT NULL,
    debate_id uuid NOT NULL REFERENCES public.debates(id),
    speaker speaker_type NOT NULL,
    content TEXT NOT NULL,
    order_number INTEGER NOT NULL,
    created_at timestamp with time zone NOT NULL DEFAULT now()
);
-- Enable RLS on debates table
ALTER TABLE public.debates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.debates FORCE ROW LEVEL SECURITY;
-- Policy for SELECT, INSERT, UPDATE, DELETE on debates
CREATE POLICY select_debates_policy ON public.debates FOR
SELECT USING (auth.uid() = user_id);
CREATE POLICY insert_debates_policy ON public.debates FOR
INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY update_debates_policy ON public.debates FOR
UPDATE USING (auth.uid() = user_id);
CREATE POLICY delete_debates_policy ON public.debates FOR DELETE USING (auth.uid() = user_id);
-- Enable RLS on turns table
ALTER TABLE public.turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.turns FORCE ROW LEVEL SECURITY;
-- Policy for SELECT, INSERT, UPDATE, DELETE on turns
CREATE POLICY select_turns_policy ON public.turns FOR
SELECT USING (auth.uid() = user_id);
CREATE POLICY insert_turns_policy ON public.turns FOR
INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY update_turns_policy ON public.turns FOR
UPDATE USING (auth.uid() = user_id);
CREATE POLICY delete_turns_policy ON public.turns FOR DELETE USING (auth.uid() = user_id);
create table public.profiles (
    id uuid not null references auth.users on delete cascade primary key,
    plan TEXT not null DEFAULT 'free'
);
alter table public.profiles enable row level security;
-- inserts a row into public.profiles
create function public.handle_new_user() returns trigger as $$ begin
insert into public.profiles (id)
values (new.id);
return new;
end;
$$ language plpgsql security definer;
create trigger on_auth_user_created
after
insert on auth.users for each row execute procedure public.handle_new_user();