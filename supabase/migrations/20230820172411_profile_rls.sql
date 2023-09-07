CREATE POLICY select_profile_policy ON public.profiles FOR
SELECT USING (auth.uid() = id);