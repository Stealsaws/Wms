-- ============================================================
-- WMS Schema — คลังสินค้าใช้ร่วมกัน 3 ทีม (Admin / A / B / C)
-- รันไฟล์นี้ทั้งหมดใน Supabase SQL Editor ครั้งเดียว (Run)
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- TABLES ----------

create table if not exists products (
  code            text primary key,
  name            text not null,
  price           numeric not null default 0,
  stock_initial   integer not null default 0,
  stock_remaining integer not null default 0,
  updated_at      timestamptz not null default now()
);

create table if not exists orders (
  id           uuid primary key default gen_random_uuid(),
  team         text not null check (team in ('A','B','C')),
  status       text not null default 'open' check (status in ('open','completed')),
  note         text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists order_items (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  product_code  text not null references products(code),
  product_name  text not null,
  qty           integer not null check (qty > 0),
  unit_price    numeric not null default 0,
  created_at    timestamptz not null default now()
);

-- team_credentials is locked down: no direct select/insert/update from the
-- client is ever allowed. All access goes through SECURITY DEFINER
-- functions below, which is what keeps the anon key from being able to
-- read or guess passwords directly.
create table if not exists team_credentials (
  team          text primary key check (team in ('ADMIN','A','B','C')),
  password_hash text not null
);

-- Seed default passwords — CHANGE THESE right after running this file
-- (see the Admin page's "เปลี่ยนรหัสผ่าน" section, or update via SQL).
insert into team_credentials (team, password_hash) values
  ('ADMIN', crypt('admin1234', gen_salt('bf'))),
  ('A',     crypt('teama1234', gen_salt('bf'))),
  ('B',     crypt('teamb1234', gen_salt('bf'))),
  ('C',     crypt('teamc1234', gen_salt('bf')))
on conflict (team) do nothing;

-- ---------- ROW LEVEL SECURITY ----------

alter table products         enable row level security;
alter table orders           enable row level security;
alter table order_items      enable row level security;
alter table team_credentials enable row level security;

-- Everyone (using the public anon key) can READ products / orders / items —
-- needed for the stock list and dashboard. No direct INSERT/UPDATE/DELETE
-- policies are created for these tables, so the only way to write to them
-- is through the RPC functions below (SECURITY DEFINER bypasses RLS).
create policy "public read products"    on products    for select using (true);
create policy "public read orders"      on orders      for select using (true);
create policy "public read order_items" on order_items for select using (true);
-- team_credentials: no policies at all = no direct access from the client, ever.

-- ---------- LOGIN ----------

create or replace function verify_login(p_team text, p_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text;
begin
  select password_hash into v_hash from team_credentials where team = p_team;
  if v_hash is null then
    return false;
  end if;
  return v_hash = crypt(p_password, v_hash);
end;
$$;

create or replace function change_password(p_team text, p_old_password text, p_new_password text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_login(p_team, p_old_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  update team_credentials
    set password_hash = crypt(p_new_password, gen_salt('bf'))
    where team = p_team;
  return true;
end;
$$;

-- ---------- TEAM: CHECKOUT CART (atomic, race-safe) ----------
-- p_items example: '[{"code":"123","qty":2},{"code":"456","qty":1}]'
-- All-or-nothing: if ANY item doesn't have enough stock, the whole
-- cart is rejected and nothing is deducted (the function raises and
-- Postgres rolls back the entire transaction automatically).
create or replace function purchase_cart(p_team text, p_password text, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order_id uuid;
  v_item     jsonb;
  v_code     text;
  v_qty      integer;
  v_name     text;
  v_price    numeric;
  v_new_remaining integer;
begin
  if p_team not in ('A','B','C') then
    raise exception 'INVALID_TEAM';
  end if;
  if not verify_login(p_team, p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_CART';
  end if;

  insert into orders (team, status) values (p_team, 'open') returning id into v_order_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_code := v_item->>'code';
    v_qty  := (v_item->>'qty')::integer;

    if v_qty is null or v_qty <= 0 then
      raise exception 'INVALID_QTY: %', v_code;
    end if;

    select name, price into v_name, v_price from products where code = v_code;
    if v_name is null then
      raise exception 'PRODUCT_NOT_FOUND: %', v_code;
    end if;

    -- Atomic, race-safe deduction: the WHERE clause re-checks stock at the
    -- moment of the actual row update, inside Postgres's own row lock, so
    -- two simultaneous purchases can never both succeed on the same units.
    update products
      set stock_remaining = stock_remaining - v_qty,
          updated_at = now()
      where code = v_code and stock_remaining >= v_qty
      returning stock_remaining into v_new_remaining;

    if v_new_remaining is null then
      raise exception 'INSUFFICIENT_STOCK: %|%|%', v_code, v_name,
        (select stock_remaining from products where code = v_code);
    end if;

    insert into order_items (order_id, product_code, product_name, qty, unit_price)
    values (v_order_id, v_code, v_name, v_qty, coalesce(v_price, 0));
  end loop;

  return jsonb_build_object('order_id', v_order_id);
end;
$$;

-- ---------- ADMIN FUNCTIONS ----------
-- Every admin function re-checks the admin password itself (defense in
-- depth), so even a leaked anon key can't be used to write data without it.

create or replace function admin_add_product(p_password text, p_code text, p_name text, p_price numeric, p_stock integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_login('ADMIN', p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  insert into products (code, name, price, stock_initial, stock_remaining)
  values (p_code, p_name, coalesce(p_price,0), coalesce(p_stock,0), coalesce(p_stock,0))
  on conflict (code) do update set
    name = excluded.name,
    price = excluded.price;
end;
$$;

create or replace function admin_edit_product(p_password text, p_code text, p_name text, p_price numeric)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_login('ADMIN', p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  update products set name = p_name, price = p_price, updated_at = now()
  where code = p_code;
end;
$$;

-- Adjust stock by a signed delta (+ restock, - manual correction).
create or replace function admin_adjust_stock(p_password text, p_code text, p_delta integer, p_note text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new integer;
begin
  if not verify_login('ADMIN', p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  update products
    set stock_remaining = stock_remaining + p_delta,
        stock_initial = case when p_delta > 0 then stock_initial + p_delta else stock_initial end,
        updated_at = now()
    where code = p_code
    returning stock_remaining into v_new;
  if v_new is null then
    raise exception 'PRODUCT_NOT_FOUND';
  end if;
  return v_new;
end;
$$;

create or replace function admin_delete_product(p_password text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_login('ADMIN', p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  delete from products where code = p_code;
end;
$$;

create or replace function admin_set_order_status(p_password text, p_order_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not verify_login('ADMIN', p_password) then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_status not in ('open','completed') then
    raise exception 'INVALID_STATUS';
  end if;
  update orders
    set status = p_status,
        completed_at = case when p_status = 'completed' then now() else null end
    where id = p_order_id;
end;
$$;

-- ============================================================
-- After running this file, run supabase/seed_products.sql once
-- to load the 48 products from your existing stock sheet.
-- ============================================================
