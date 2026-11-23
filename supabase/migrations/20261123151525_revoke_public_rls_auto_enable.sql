-- The event trigger is already registered; public clients must not be able to invoke its SECURITY DEFINER function through PostgREST.
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
