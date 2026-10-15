-- AutoOrder secure starter schema (single-store / workspace-scoped).
-- Apply ONLY to a NEW Supabase project after reviewing. Test in staging first.
-- No service_role key belongs in browser code. RLS is mandatory.
begin;

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','seller','buyer','support','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (length(display_name) <= 120),
  phone text check (phone is null or length(phone) <= 32),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 180),
  description text not null default '' check (length(description) <= 4000),
  price bigint not null check (price >= 0 and price <= 100000000000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id)
);
create index if not exists products_workspace_active_idx on public.products(workspace_id, active, created_at desc);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  product_name text not null check (length(product_name) <= 180),
  quantity integer not null check (quantity between 1 and 100),
  unit_price bigint not null check (unit_price >= 0),
  total_price bigint generated always as (quantity::bigint * unit_price) stored,
  status text not null default 'menunggu_pembayaran'
    check (status in ('menunggu_pembayaran','menunggu_verifikasi','diproses','selesai','dibatalkan','ditolak')),
  payment_reference text check (payment_reference is null or length(payment_reference) <= 160),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (buyer_id, idempotency_key)
);
create index if not exists orders_workspace_created_idx on public.orders(workspace_id, created_at desc);
create index if not exists orders_buyer_created_idx on public.orders(buyer_id, created_at desc);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  status text not null default 'open' check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversations_workspace_updated_idx on public.conversations(workspace_id, updated_at desc);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references auth.users(id) on delete restrict,
  body text not null check (length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists messages_conversation_created_idx on public.messages(conversation_id, created_at);

create table if not exists public.warranties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'active' check (status in ('active','claimed','expired','revoked')),
  details text not null default '' check (length(details) <= 2000),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists warranties_buyer_idx on public.warranties(buyer_id, created_at desc);

create table if not exists public.loyalty_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  order_id uuid references public.orders(id) on delete set null,
  event_type text not null check (event_type in ('eligible_order','reward_granted','reward_redeemed','adjustment')),
  points integer not null default 0 check (points between -100000 and 100000),
  description text not null default '' check (length(description) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists loyalty_buyer_idx on public.loyalty_events(buyer_id, created_at desc);

-- Membership helpers bypass recursive RLS safely; callers cannot choose a user ID.
create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id and wm.user_id = (select auth.uid())
  );
$$;

create or replace function public.has_workspace_role(p_workspace_id uuid, p_roles text[])
returns boolean language sql stable security definer
set search_path = pg_catalog, public, auth
as $$
  select exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.role = any(p_roles)
  );
$$;

revoke all on function public.is_workspace_member(uuid) from public, anon;
revoke all on function public.has_workspace_role(uuid,text[]) from public, anon;
grant execute on function public.is_workspace_member(uuid) to authenticated;
grant execute on function public.has_workspace_role(uuid,text[]) to authenticated;

-- Orders are created through a trusted database function, not by trusting browser prices.
create or replace function public.create_order(p_product_id uuid, p_quantity integer, p_idempotency_key uuid)
returns public.orders
language plpgsql security definer
set search_path = pg_catalog, public, auth
as $$
declare
  v_user uuid := auth.uid();
  v_product public.products%rowtype;
  v_order public.orders%rowtype;
begin
  if v_user is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 100 then
    raise exception 'invalid_quantity' using errcode = '22023';
  end if;
  if p_idempotency_key is null then raise exception 'idempotency_key_required' using errcode = '22023'; end if;

  -- Return the existing order for a retry with the same key.
  select * into v_order from public.orders
  where buyer_id = v_user and idempotency_key = p_idempotency_key;
  if found then return v_order; end if;

  select p.* into v_product from public.products p
  where p.id = p_product_id and p.active = true;
  if not found then raise exception 'product_unavailable' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = v_product.workspace_id and wm.user_id = v_user and wm.role = 'buyer'
  ) then raise exception 'buyer_membership_required' using errcode = '42501'; end if;

  insert into public.orders(workspace_id,buyer_id,product_id,product_name,quantity,unit_price,idempotency_key)
  values (v_product.workspace_id,v_user,v_product.id,v_product.name,p_quantity,v_product.price,p_idempotency_key)
  returning * into v_order;
  return v_order;
exception when unique_violation then
  select * into v_order from public.orders
  where buyer_id = auth.uid() and idempotency_key = p_idempotency_key;
  if found then return v_order; end if;
  raise;
end;
$$;
revoke all on function public.create_order(uuid,integer,uuid) from public, anon;
grant execute on function public.create_order(uuid,integer,uuid) to authenticated;

-- Updated timestamp helper.
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = pg_catalog
as $$ begin new.updated_at = now(); return new; end; $$;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger products_set_updated_at before update on public.products for each row execute function public.set_updated_at();
create trigger orders_set_updated_at before update on public.orders for each row execute function public.set_updated_at();

-- Enforce a small, explicit order-status state machine on the server.
create or replace function public.enforce_order_status_transition()
returns trigger language plpgsql set search_path = pg_catalog, public
as $$
begin
  if new.status is distinct from old.status then
    if not (
      (old.status = 'menunggu_pembayaran' and new.status in ('menunggu_verifikasi','dibatalkan','ditolak')) or
      (old.status = 'menunggu_verifikasi' and new.status in ('diproses','dibatalkan','ditolak')) or
      (old.status = 'diproses' and new.status in ('selesai','ditolak'))
    ) then
      raise exception 'invalid_order_status_transition' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$$;
create trigger orders_status_transition before update on public.orders
for each row execute function public.enforce_order_status_transition();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();

-- RLS on every table containing customer/business data.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.warranties enable row level security;
alter table public.loyalty_events enable row level security;

-- No anon access to personal/customer tables.
revoke all on public.workspaces, public.workspace_members, public.profiles, public.products,
  public.orders, public.conversations, public.messages, public.warranties, public.loyalty_events
from anon;
grant select on public.workspaces, public.workspace_members, public.profiles, public.products,
  public.orders, public.conversations, public.messages, public.warranties, public.loyalty_events
 to authenticated;
grant insert, update on public.profiles to authenticated;
grant insert, update, delete on public.products to authenticated;
grant update(status) on public.orders to authenticated;
grant insert on public.conversations to authenticated;
grant insert on public.messages to authenticated;
-- Do not grant direct INSERT/DELETE on orders, memberships, warranties, or loyalty_events.

create policy workspaces_member_read on public.workspaces for select to authenticated
using (public.is_workspace_member(id));
create policy members_read_self_or_managers on public.workspace_members for select to authenticated
using (user_id = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));
create policy profiles_read_self on public.profiles for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_insert_self on public.profiles for insert to authenticated with check (user_id = (select auth.uid()));
create policy profiles_update_self on public.profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy products_member_read on public.products for select to authenticated
using (active = true and public.is_workspace_member(workspace_id)
  or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));
create policy products_manager_insert on public.products for insert to authenticated
with check (public.has_workspace_role(workspace_id, array['owner','seller']::text[]));
create policy products_manager_update on public.products for update to authenticated
using (public.has_workspace_role(workspace_id, array['owner','seller']::text[]))
with check (public.has_workspace_role(workspace_id, array['owner','seller']::text[]));
create policy products_manager_delete on public.products for delete to authenticated
using (public.has_workspace_role(workspace_id, array['owner']::text[]));

create policy orders_buyer_or_staff_read on public.orders for select to authenticated
using (buyer_id = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));
create policy orders_staff_update_status on public.orders for update to authenticated
using (public.has_workspace_role(workspace_id, array['owner','seller']::text[]))
with check (public.has_workspace_role(workspace_id, array['owner','seller']::text[]));

create policy conversations_participant_read on public.conversations for select to authenticated
using (buyer_id = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));
create policy conversations_buyer_create on public.conversations for insert to authenticated
with check (buyer_id = (select auth.uid()) and public.has_workspace_role(workspace_id, array['buyer']::text[])
  and (order_id is null or exists (select 1 from public.orders o where o.id = order_id and o.buyer_id = (select auth.uid()) and o.workspace_id = conversations.workspace_id)));
create policy messages_participant_read on public.messages for select to authenticated
using (exists (select 1 from public.conversations c where c.id = conversation_id
  and (c.buyer_id = (select auth.uid()) or public.has_workspace_role(c.workspace_id, array['owner','seller','support']::text[]))));
create policy messages_participant_insert on public.messages for insert to authenticated
with check (sender_id = (select auth.uid()) and exists (
  select 1 from public.conversations c where c.id = conversation_id and c.status = 'open'
  and (c.buyer_id = (select auth.uid()) or public.has_workspace_role(c.workspace_id, array['owner','seller','support']::text[]))));

create policy warranties_buyer_or_staff_read on public.warranties for select to authenticated
using (buyer_id = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));
create policy loyalty_buyer_or_staff_read on public.loyalty_events for select to authenticated
using (buyer_id = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','seller','support']::text[]));

commit;
