create trigger handle_new_auth_user
after insert
on auth.users
for each row
execute function public.lookup_agents_by_email_after_insert_on_auth_users();