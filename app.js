import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.0';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const authPanel = $('auth-panel');
const appPanel = $('app-panel');
const notice = $('notice');
const productsNode = $('products');
const ordersNode = $('orders');
const managerNode = $('product-manager');
const managedProductsNode = $('managed-products');
let client;
let currentUser;
let currentRole = 'buyer';
let currentWorkspaceId = null;

function notify(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle('error', isError);
  notice.classList.remove('hidden');
  notice.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function clearNotice() { notice.classList.add('hidden'); notice.textContent = ''; }
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function rupiah(value) {
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value || 0));
}
function statusLabel(status) {
  return ({menunggu_pembayaran:'Menunggu pembayaran',menunggu_verifikasi:'Menunggu verifikasi',diproses:'Diproses',selesai:'Selesai',dibatalkan:'Dibatalkan',ditolak:'Ditolak'})[status] || 'Status tidak diketahui';
}
function validateConfig() {
  if (!SUPABASE_URL.startsWith('https://') || SUPABASE_URL.includes('YOUR_PROJECT_REF') || SUPABASE_ANON_KEY.includes('YOUR_SUPABASE_')) {
    authPanel.prepend(element('p', 'notice error', 'Konfigurasi belum diisi. Edit web/config.js dengan Project URL dan publishable/anon key dari proyek Supabase BARU. Jangan masukkan service_role key.'));
    $('login-button').disabled = true;
    $('signup-button').disabled = true;
    return false;
  }
  return true;
}
async function ensureMembership() {
  const { data, error } = await client.functions.invoke('join-store', { body: {} });
  if (error || !data?.ok) throw new Error('Akun belum terhubung ke toko. Pastikan Edge Function join-store dan variabel server telah dipasang.');
  // Workspace ID is returned by the trusted function, never accepted from a user form.
  if (!data.workspace_id) throw new Error('Workspace toko belum dikonfigurasi.');
  const { data: membership, error: membershipError } = await client.from('workspace_members')
    .select('workspace_id,role').eq('workspace_id', data.workspace_id).eq('user_id', (await client.auth.getUser()).data.user.id).maybeSingle();
  if (membershipError || !membership || membership.role !== data.role) throw new Error('Keanggotaan toko tidak ditemukan.');
  currentRole = membership.role;
  currentWorkspaceId = membership.workspace_id;
}
function canManageProducts() { return ['owner','seller'].includes(currentRole) && Boolean(currentWorkspaceId); }
async function showApp(user) {
  currentUser = user;
  authPanel.classList.add('hidden');
  appPanel.classList.remove('hidden');
  $('session-label').textContent = user.email || 'Akun aktif';
  $('role-note').textContent = currentRole === 'buyer' ? 'Akun pelanggan' : `Akses toko: ${currentRole}`;
  managerNode.classList.toggle('hidden', !canManageProducts());
  clearNotice();
  await Promise.all([loadProducts(), loadOrders(), canManageProducts() ? loadManagedProducts() : Promise.resolve()]);
}
function showAuth() {
  currentUser = null;
  currentRole = 'buyer';
  currentWorkspaceId = null;
  appPanel.classList.add('hidden');
  authPanel.classList.remove('hidden');
  $('session-label').textContent = 'Belum masuk';
}
async function loadProducts() {
  productsNode.replaceChildren(element('p','muted','Memuat katalog…'));
  let query = client.from('products').select('id,workspace_id,name,description,price,active').eq('active', true).order('created_at', { ascending: false }).limit(100);
  if (currentWorkspaceId) query = query.eq('workspace_id', currentWorkspaceId);
  const { data, error } = await query;
  if (error) { productsNode.replaceChildren(element('p','muted','Katalog tidak dapat dimuat. Periksa keanggotaan toko dan kebijakan RLS.')); return; }
  productsNode.replaceChildren();
  if (!data?.length) { productsNode.append(element('p','muted','Belum ada produk aktif. Seller dapat menambahkan produk dari panel Kelola produk.')); return; }
  for (const product of data) {
    const card = element('article','product');
    card.append(element('h3','',product.name));
    card.append(element('p','',product.description || ''));
    card.append(element('div','price',rupiah(product.price)));
    const button = element('button','','Buat pesanan');
    button.addEventListener('click', () => createOrder(product.id, product.name, button));
    card.append(button);
    productsNode.append(card);
  }
}
function resetProductForm() {
  $('product-form').reset();
  $('product-id').value = '';
  $('product-active').checked = true;
  $('save-product').textContent = 'Simpan produk';
}
async function loadManagedProducts() {
  if (!canManageProducts()) return;
  managedProductsNode.replaceChildren(element('p','muted','Memuat produk…'));
  const { data, error } = await client.from('products').select('id,name,description,price,active,created_at')
    .eq('workspace_id', currentWorkspaceId).order('created_at',{ascending:false}).limit(200);
  if (error) { managedProductsNode.replaceChildren(element('p','muted','Daftar produk gagal dimuat. Periksa kebijakan RLS.')); return; }
  managedProductsNode.replaceChildren();
  if (!data?.length) { managedProductsNode.append(element('p','muted','Belum ada produk. Isi formulir di atas untuk menambah produk pertama.')); return; }
  for (const product of data) {
    const row = element('article','managed-product');
    const info = element('div');
    info.append(element('h3','',product.name));
    info.append(element('p','',rupiah(product.price)));
    if (!product.active) info.append(element('span','inactive-label','NONAKTIF — tidak tampil ke buyer'));
    row.append(info);
    const actions = element('div','managed-actions');
    const edit = element('button','secondary','Edit');
    edit.addEventListener('click', () => {
      $('product-id').value = product.id;
      $('product-name').value = product.name;
      $('product-description').value = product.description || '';
      $('product-price').value = String(product.price);
      $('product-active').checked = product.active;
      $('save-product').textContent = 'Simpan perubahan';
      $('product-name').focus();
      $('product-form').scrollIntoView({ behavior:'smooth', block:'start' });
    });
    const toggle = element('button','secondary',product.active ? 'Nonaktifkan' : 'Aktifkan');
    toggle.addEventListener('click', () => setProductActive(product, !product.active, toggle));
    actions.append(edit, toggle);
    if (currentRole === 'owner') {
      const remove = element('button','secondary','Hapus');
      remove.addEventListener('click', () => deleteProduct(product, remove));
      actions.append(remove);
    }
    row.append(actions);
    managedProductsNode.append(row);
  }
}
async function saveProduct(event) {
  event.preventDefault();
  if (!canManageProducts()) { notify('Hanya owner atau seller yang berhak mengelola produk.', true); return; }
  const id = $('product-id').value;
  const name = $('product-name').value.trim();
  const description = $('product-description').value.trim();
  const price = Number($('product-price').value);
  const active = $('product-active').checked;
  if (!name || name.length > 180 || description.length > 4000 || !Number.isSafeInteger(price) || price < 0 || price > 100000000000) {
    notify('Periksa nama, deskripsi, dan harga. Harga harus berupa bilangan Rupiah bulat yang valid.', true); return;
  }
  const button = $('save-product');
  button.disabled = true;
  const payload = { workspace_id: currentWorkspaceId, name, description, price, active };
  try {
    let result;
    if (id) result = await client.from('products').update({ name, description, price, active }).eq('id', id).eq('workspace_id', currentWorkspaceId).select('id').single();
    else result = await client.from('products').insert(payload).select('id').single();
    if (result.error) throw result.error;
    resetProductForm();
    notify(id ? 'Produk berhasil diperbarui di database.' : 'Produk berhasil ditambahkan ke database.');
    await Promise.all([loadProducts(), loadManagedProducts()]);
  } catch (error) {
    notify('Gagal menyimpan produk. Pastikan akun berperan owner/seller, workspace benar, dan migrasi RLS telah diterapkan.', true);
  } finally { button.disabled = false; }
}
async function setProductActive(product, active, button) {
  if (!canManageProducts()) return;
  button.disabled = true;
  try {
    const { error } = await client.from('products').update({ active }).eq('id', product.id).eq('workspace_id', currentWorkspaceId);
    if (error) throw error;
    notify(active ? 'Produk diaktifkan.' : 'Produk dinonaktifkan dan tidak tampil pada katalog buyer.');
    await Promise.all([loadProducts(), loadManagedProducts()]);
  } catch { notify('Status produk gagal diubah. Periksa izin seller dan RLS.', true); }
  finally { button.disabled = false; }
}
async function deleteProduct(product, button) {
  if (currentRole !== 'owner') { notify('Hanya owner yang dapat menghapus produk. Seller dapat menonaktifkannya.', true); return; }
  if (!window.confirm(`Hapus produk “${product.name}”? Pesanan lama tetap menyimpan snapshot nama dan harga.`)) return;
  button.disabled = true;
  try {
    const { error } = await client.from('products').delete().eq('id', product.id).eq('workspace_id', currentWorkspaceId);
    if (error) throw error;
    notify('Produk dihapus.');
    await Promise.all([loadProducts(), loadManagedProducts()]);
  } catch { notify('Produk gagal dihapus. Jika sudah dipakai dalam pesanan, nonaktifkan produk sebagai gantinya.', true); }
  finally { button.disabled = false; }
}
async function createOrder(productId, productName, button) {
  if (currentRole !== 'buyer') { notify('Akun ini bukan role buyer. Gunakan akun pelanggan terpisah untuk membuat pesanan.', true); return; }
  if (!window.confirm(`Buat pesanan untuk “${productName}”? Harga final diambil dan divalidasi oleh database.`)) return;
  button.disabled = true;
  try {
    const { data, error } = await client.rpc('create_order', { p_product_id: productId, p_quantity: 1, p_idempotency_key: crypto.randomUUID() });
    if (error) throw error;
    notify(`Pesanan dibuat dengan ID ${data.id}. Status awal: menunggu pembayaran. Pembayaran belum diverifikasi otomatis.`);
    await loadOrders();
  } catch (error) {
    notify(error?.message?.includes('buyer_membership_required') ? 'Akun ini belum memiliki keanggotaan buyer pada toko.' : 'Pesanan gagal dibuat. Periksa koneksi, role akun, dan log database.', true);
  } finally { button.disabled = false; }
}
async function loadOrders() {
  ordersNode.replaceChildren(element('p','muted','Memuat pesanan…'));
  let query = client.from('orders').select('id,workspace_id,product_name,quantity,total_price,status,created_at').order('created_at',{ascending:false}).limit(100);
  if (currentWorkspaceId) query = query.eq('workspace_id', currentWorkspaceId);
  const { data, error } = await query;
  if (error) { ordersNode.replaceChildren(element('p','muted','Riwayat pesanan tidak dapat dimuat. Periksa kebijakan RLS.')); return; }
  ordersNode.replaceChildren();
  if (!data?.length) { ordersNode.append(element('p','muted','Belum ada pesanan.')); return; }
  for (const order of data) {
    const card = element('article','order');
    const details = element('div');
    details.append(element('h3','',order.product_name));
    details.append(element('p','',`ID: ${order.id}`));
    details.append(element('p','',`${order.quantity} item • ${new Date(order.created_at).toLocaleString('id-ID')}`));
    details.append(element('p','',rupiah(order.total_price)));
    card.append(details, element('span','status',statusLabel(order.status)));
    ordersNode.append(card);
  }
}
async function init() {
  if (!validateConfig()) return;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: window.sessionStorage },
    global: { headers: { 'X-Client-Info': 'autoorder-secure-starter' } },
  });
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault(); clearNotice();
    const email = $('email').value.trim();
    const password = $('password').value;
    $('login-button').disabled = true;
    try {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await ensureMembership();
      await showApp(data.user);
    } catch (error) { notify('Gagal masuk atau menyiapkan akun. Periksa email/kata sandi, verifikasi email, dan konfigurasi server.', true); }
    finally { $('login-button').disabled = false; }
  });
  $('signup-button').addEventListener('click', async () => {
    clearNotice();
    const email = $('email').value.trim();
    const password = $('password').value;
    const displayName = $('display-name').value.trim();
    if (!email || password.length < 10) { notify('Isi email valid dan kata sandi minimal 10 karakter.', true); return; }
    $('signup-button').disabled = true;
    try {
      const { data, error } = await client.auth.signUp({ email, password, options: { data: { display_name: displayName.slice(0,120) } } });
      if (error) throw error;
      if (!data.session) notify('Pendaftaran diterima. Buka email untuk verifikasi, lalu masuk. Akun belum aktif untuk membuat pesanan.');
      else { await ensureMembership(); await showApp(data.user); }
    } catch (error) { notify('Pendaftaran gagal. Periksa input dan konfigurasi verifikasi email Supabase.', true); }
    finally { $('signup-button').disabled = false; }
  });
  $('logout-button').addEventListener('click', async () => { await client.auth.signOut(); showAuth(); });
  $('refresh-products').addEventListener('click', loadProducts);
  $('refresh-orders').addEventListener('click', loadOrders);
  $('product-form').addEventListener('submit', saveProduct);
  $('reset-product-form').addEventListener('click', resetProductForm);
  $('cancel-product-edit').addEventListener('click', resetProductForm);
  $('refresh-managed-products').addEventListener('click', loadManagedProducts);
  const { data: { session } } = await client.auth.getSession();
  if (session?.user) {
    try { await ensureMembership(); await showApp(session.user); }
    catch { showAuth(); notify('Sesi ada tetapi akses toko belum tersedia. Masuk ulang atau hubungi administrator.', true); }
  }
}
init().catch(() => notify('Aplikasi gagal dimulai. Periksa konfigurasi Supabase.', true));
