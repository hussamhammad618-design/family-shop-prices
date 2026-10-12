import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const CURRENCY = window.SHOP_CURRENCY || 'ل.س'; // غيّرها إذا كانت عملة المتجر مختلفة.
const $ = (id) => document.getElementById(id);
const loginPanel = $('loginPanel');
const appPanel = $('appPanel');
const loginForm = $('loginForm');
const productForm = $('productForm');
const setupNotice = $('setupNotice');
const globalNotice = $('globalNotice');
const productsList = $('productsList');
const loadingProducts = $('loadingProducts');
const emptyProducts = $('emptyProducts');
const connectionBadge = $('connectionBadge');
const logoutBtn = $('logoutBtn');
const productName = $('productName');
const productPrice = $('productPrice');
const productUnit = $('productUnit');
const productCategory = $('productCategory');
const productNotes = $('productNotes');
const searchInput = $('searchInput');
const categoryFilter = $('categoryFilter');
const saveProductBtn = $('saveProductBtn');
const cancelEditBtn = $('cancelEditBtn');

$('currencyLabel').textContent = CURRENCY;
let auth;
let db;
let currentUser = null;
let products = [];
let editingId = null;
let unsubscribeProducts = null;
let noticeTimeout;

function showNotice(message, type = 'error', timeout = 6000) {
  clearTimeout(noticeTimeout);
  globalNotice.className = `notice notice-${type}`;
  globalNotice.textContent = message;
  globalNotice.classList.remove('hidden');
  if (timeout > 0) noticeTimeout = setTimeout(() => globalNotice.classList.add('hidden'), timeout);
}

function friendlyAuthError(error) {
  const code = error?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
  if (code.includes('invalid-email')) return 'يرجى إدخال بريد إلكتروني صحيح.';
  if (code.includes('too-many-requests')) return 'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.';
  if (code.includes('network-request-failed')) return 'تعذر الاتصال بالإنترنت. تحقق من الاتصال وحاول مجددًا.';
  return 'تعذر تسجيل الدخول. تأكد من إعداد Firebase ومن صحة الحساب.';
}

function hasPlaceholderConfig() {
  return !firebaseConfig.apiKey || firebaseConfig.apiKey.includes('PASTE_') ||
    !firebaseConfig.projectId || firebaseConfig.projectId.includes('YOUR_') ||
    !firebaseConfig.appId || firebaseConfig.appId.includes('PASTE_');
}

function setConnection(label, state = 'offline') {
  connectionBadge.className = `status-badge status-${state}`;
  connectionBadge.lastChild?.remove();
  connectionBadge.append(document.createTextNode(` ${label}`));
}

function escapeText(value) {
  return String(value ?? '');
}

function formatPrice(value) {
  const n = Number(value);
  return new Intl.NumberFormat('ar-SY', { maximumFractionDigits: 2 }).format(Number.isFinite(n) ? n : 0);
}

function formatDate(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== 'function') return 'الآن';
  return new Intl.DateTimeFormat('ar-SY', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(timestamp.toDate());
}

function updateStats() {
  $('totalProducts').textContent = String(products.length);
  $('totalCategories').textContent = String(new Set(products.map(p => (p.category || 'أخرى').trim()).filter(Boolean)).size);
  const latest = products.reduce((acc, p) => {
    const millis = p.updatedAt?.toMillis?.() || p.createdAt?.toMillis?.() || 0;
    return Math.max(acc, millis);
  }, 0);
  $('lastUpdated').textContent = latest ? new Intl.DateTimeFormat('ar-SY', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date(latest)) : '—';
  $('visibleCount').textContent = `${visibleProducts().length} منتج`;
}

function visibleProducts() {
  const q = searchInput.value.trim().toLocaleLowerCase('ar');
  const category = categoryFilter.value;
  return products.filter(p => {
    const matchesQuery = !q || `${p.name || ''} ${p.category || ''} ${p.notes || ''}`.toLocaleLowerCase('ar').includes(q);
    return matchesQuery && (!category || (p.category || 'أخرى') === category);
  }).sort((a,b) => (a.name || '').localeCompare(b.name || '', 'ar'));
}

function makeIconButton(symbol, label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `icon-button ${className || ''}`.trim();
  button.setAttribute('aria-label', label);
  button.title = label;
  button.textContent = symbol;
  button.addEventListener('click', onClick);
  return button;
}

function renderProducts() {
  const shown = visibleProducts();
  productsList.replaceChildren();
  $('visibleCount').textContent = `${shown.length} منتج`;
  if (products.length === 0) {
    emptyProducts.classList.remove('hidden');
    emptyProducts.querySelector('strong').textContent = 'لا توجد منتجات بعد';
    emptyProducts.querySelector('p').textContent = 'أضف أول منتج من النموذج الموجود بجانبك.';
  } else if (shown.length === 0) {
    emptyProducts.classList.remove('hidden');
    emptyProducts.querySelector('strong').textContent = 'لا توجد نتائج';
    emptyProducts.querySelector('p').textContent = 'جرّب تغيير عبارة البحث أو اختيار تصنيف آخر.';
  } else {
    emptyProducts.classList.add('hidden');
  }

  for (const product of shown) {
    const card = document.createElement('article');
    card.className = 'product-card';

    const symbol = document.createElement('div');
    symbol.className = 'product-symbol';
    symbol.textContent = '📦';
    symbol.setAttribute('aria-hidden', 'true');

    const main = document.createElement('div');
    main.className = 'product-main';
    const titleRow = document.createElement('div');
    titleRow.className = 'product-title-row';
    const title = document.createElement('h3');
    title.className = 'product-title';
    title.textContent = escapeText(product.name);
    titleRow.append(title);
    if (product.category) {
      const cat = document.createElement('span');
      cat.className = 'category-pill';
      cat.textContent = escapeText(product.category);
      titleRow.append(cat);
    }
    const meta = document.createElement('div');
    meta.className = 'product-meta';
    const metaParts = [`الوحدة: ${escapeText(product.unit || 'قطعة')}`];
    if (product.updatedBy) metaParts.push(`آخر تعديل: ${escapeText(product.updatedBy)}`);
    if (product.notes) metaParts.push(escapeText(product.notes));
    meta.textContent = metaParts.join(' · ');
    main.append(titleRow, meta);

    const price = document.createElement('div');
    price.className = 'product-price';
    price.textContent = formatPrice(product.price);
    const currency = document.createElement('small');
    currency.textContent = ` ${CURRENCY}`;
    price.append(currency);

    const actions = document.createElement('div');
    actions.className = 'product-actions';
    actions.append(
      makeIconButton('✎', 'تعديل المنتج', 'edit', () => startEdit(product)),
      makeIconButton('×', 'حذف المنتج', 'delete', () => removeProduct(product))
    );
    card.append(symbol, main, price, actions);
    productsList.append(card);
  }
  updateStats();
}

function updateCategoryOptions() {
  const prior = categoryFilter.value;
  const categories = [...new Set(products.map(p => (p.category || 'أخرى').trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b, 'ar'));
  categoryFilter.replaceChildren();
  const all = document.createElement('option');
  all.value = '';
  all.textContent = 'كل التصنيفات';
  categoryFilter.append(all);
  categories.forEach(category => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    categoryFilter.append(option);
  });
  if (categories.includes(prior)) categoryFilter.value = prior;
}

function startEdit(product) {
  editingId = product.id;
  $('formTitle').textContent = 'تعديل بيانات المنتج';
  saveProductBtn.textContent = 'حفظ التعديلات';
  cancelEditBtn.classList.remove('hidden');
  productName.value = product.name || '';
  productPrice.value = String(product.price ?? '');
  productUnit.value = product.unit || 'قطعة';
  productCategory.value = product.category || '';
  productNotes.value = product.notes || '';
  productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
  productName.focus({ preventScroll: true });
}

function resetProductForm() {
  editingId = null;
  productForm.reset();
  productUnit.value = 'قطعة';
  $('formTitle').textContent = 'إضافة منتج جديد';
  saveProductBtn.textContent = 'حفظ المنتج';
  cancelEditBtn.classList.add('hidden');
}

async function onSaveProduct(event) {
  event.preventDefault();
  if (!currentUser || !db) return;
  const name = productName.value.trim();
  const price = Number(productPrice.value);
  const category = productCategory.value.trim() || 'أخرى';
  const unit = productUnit.value || 'قطعة';
  const notes = productNotes.value.trim();
  if (!name) return showNotice('اكتب اسم المنتج أولًا.');
  if (productPrice.value.trim() === '' || !Number.isFinite(price) || price < 0) return showNotice('أدخل سعرًا صحيحًا أكبر من أو يساوي صفرًا.');

  saveProductBtn.disabled = true;
  saveProductBtn.textContent = 'جارٍ الحفظ...';
  const payload = { name, nameLower: name.toLocaleLowerCase('ar'), category, unit, price, notes, updatedAt: serverTimestamp(), updatedBy: currentUser.email || 'حساب العائلة' };
  try {
    if (editingId) {
      await updateDoc(doc(db, 'products', editingId), payload);
      showNotice('تم تحديث المنتج بنجاح.', 'success');
    } else {
      await addDoc(collection(db, 'products'), { ...payload, createdAt: serverTimestamp() });
      showNotice('تمت إضافة المنتج بنجاح.', 'success');
    }
    resetProductForm();
  } catch (error) {
    console.error(error);
    showNotice('لم يتم الحفظ. تأكد من صلاحيات Firestore ومن اتصال الإنترنت.');
  } finally {
    saveProductBtn.disabled = false;
    saveProductBtn.textContent = editingId ? 'حفظ التعديلات' : 'حفظ المنتج';
  }
}

async function removeProduct(product) {
  if (!currentUser || !db) return;
  const confirmed = window.confirm(`هل تريد حذف المنتج «${product.name}» نهائيًا؟`);
  if (!confirmed) return;
  try {
    await deleteDoc(doc(db, 'products', product.id));
    if (editingId === product.id) resetProductForm();
    showNotice('تم حذف المنتج.', 'success');
  } catch (error) {
    console.error(error);
    showNotice('تعذر حذف المنتج. تأكد من صلاحيات الحساب والاتصال.');
  }
}

function subscribeToProducts() {
  if (unsubscribeProducts) unsubscribeProducts();
  loadingProducts.classList.remove('hidden');
  emptyProducts.classList.add('hidden');
  productsList.replaceChildren();
  unsubscribeProducts = onSnapshot(collection(db, 'products'), snapshot => {
    products = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    loadingProducts.classList.add('hidden');
    updateCategoryOptions();
    renderProducts();
    setConnection('متصل ومتزامن', 'online');
  }, error => {
    console.error(error);
    loadingProducts.classList.add('hidden');
    setConnection('مشكلة في المزامنة', 'error');
    showNotice('تعذر تحميل المنتجات. غالبًا لم تُضف بريد هذا الحساب إلى قواعد الأمان في Firestore، أو لم تُنشئ قاعدة البيانات بعد.');
  });
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!auth) return;
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'جارٍ تسجيل الدخول...';
  try {
    await signInWithEmailAndPassword(auth, $('emailInput').value.trim(), $('passwordInput').value);
    $('passwordInput').value = '';
    globalNotice.classList.add('hidden');
  } catch (error) {
    console.error(error);
    showNotice(friendlyAuthError(error));
  } finally {
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'دخول إلى قائمة الأسعار';
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await signOut(auth); }
  catch (error) { console.error(error); showNotice('تعذر تسجيل الخروج، حاول مرة أخرى.'); }
});
productForm.addEventListener('submit', onSaveProduct);
cancelEditBtn.addEventListener('click', resetProductForm);
searchInput.addEventListener('input', renderProducts);
categoryFilter.addEventListener('change', renderProducts);

if (hasPlaceholderConfig()) {
  setupNotice.classList.remove('hidden');
  $('loginBtn').disabled = true;
  setConnection('يحتاج إلى إعداد', 'error');
} else {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    onAuthStateChanged(auth, user => {
      currentUser = user;
      if (user) {
        loginPanel.classList.add('hidden');
        appPanel.classList.remove('hidden');
        logoutBtn.classList.remove('hidden');
        $('signedInEmail').textContent = user.email || 'حساب العائلة';
        subscribeToProducts();
      } else {
        if (unsubscribeProducts) unsubscribeProducts();
        unsubscribeProducts = null;
        products = [];
        loginPanel.classList.remove('hidden');
        appPanel.classList.add('hidden');
        logoutBtn.classList.add('hidden');
        productsList.replaceChildren();
        setConnection('غير متصل', 'offline');
      }
    });
  } catch (error) {
    console.error(error);
    setupNotice.classList.remove('hidden');
    showNotice('حدث خطأ في إعداد Firebase. راجع بيانات firebase-config.js.', 'error', 0);
  }
}
