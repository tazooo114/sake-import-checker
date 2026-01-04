-- Function to truncate sake_imports table (much faster than delete)
create or replace function truncate_sake_imports()
returns void as $$
begin
  truncate table sake_imports;
end;
$$ language plpgsql security definer;
