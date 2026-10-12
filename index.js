const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fileUpload = require('express-fileupload');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt = require('bcryptjs');
const { MongoClient } = require('mongodb');

const appRoot = __dirname;
const uploadDir = path.join(appRoot, 'public', 'book_img');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const BCRYPT_ROUNDS = 12;

fs.mkdirSync(uploadDir, { recursive: true });

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeErrorDetail(error) {
  let detail = String(error?.message || error?.name || 'Unexpected error');
  for (const key of ['MONGODB_URI', 'SESSION_SECRET']) {
    const value = process.env[key];
    if (value) detail = detail.split(value).join('[redacted]');
  }
  return detail
    .replace(/mongodb(?:\+srv)?:\/\/\S+/gi, '[MongoDB URI redacted]')
    .replace(/(password|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 300);
}

function parsePositiveId(value) {
  if (!/^\d+$/.test(String(value || ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function parsePrice(value) {
  const normalized = String(value || '').trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function validateText(value, label, maxLength, required = true) {
  const text = String(value || '').trim();
  if (required && !text) throw httpError(400, `${label} is required.`);
  if (text.length > maxLength) throw httpError(400, `${label} must be ${maxLength} characters or fewer.`);
  return text;
}

function getImageInfo(file) {
  if (!file || !Buffer.isBuffer(file.data) || file.data.length === 0) throw httpError(400, 'Choose a book image to upload.');
  if (file.data.length > MAX_UPLOAD_BYTES) throw httpError(413, 'Book images must be 5 MB or smaller.');
  const data = file.data;
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { extension: '.jpg' };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { extension: '.png' };
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { extension: '.webp' };
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return { extension: '.gif' };
  throw httpError(400, 'Upload a valid JPEG, PNG, GIF, or WebP image.');
}

function getCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  return req.session.csrfToken;
}

function createApp({ collections, sessionStore, sessionSecret, secureCookies, trustProxy = false } = {}) {
  const app = express();
  if (trustProxy) app.set('trust proxy', trustProxy === true ? 1 : trustProxy);
  app.set('views', path.join(appRoot, 'views'));
  app.set('view engine', 'ejs');
  app.set('layout', 'layouts/mainlayouts');
  app.disable('x-powered-by');

  app.use(expressLayouts);
  app.use(fileUpload({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 }, abortOnLimit: true, useTempFiles: false, safeFileNames: true, preserveExtension: 4 }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use(express.static(path.join(appRoot, 'public'), { fallthrough: true }));
  app.use(session({
    name: 'bookreselling.sid',
    secret: sessionSecret || (process.env.NODE_ENV === 'production' ? undefined : crypto.randomBytes(32).toString('hex')),
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: secureCookies === undefined ? 'auto' : secureCookies, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  }));

  app.use((req, res, next) => {
    res.locals.currentCustomer = req.session.user?.role === 'customer' ? req.session.user : null;
    res.locals.currentAdmin = req.session.user?.role === 'admin' ? req.session.user : null;
    res.locals.csrfToken = getCsrfToken(req);
    res.locals.flashMessage = req.session.flashMessage || null;
    delete req.session.flashMessage;
    next();
  });

  app.get('/health', async (req, res) => {
    try {
      if (!collections) return res.status(503).send('Database unavailable');
      await collections.admins.database.admin().ping();
      res.status(200).send('OK');
    } catch (_) {
      res.status(503).send('Database unavailable');
    }
  });

  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const token = req.body?._csrf || req.headers['x-csrf-token'];
    const supplied = Buffer.from(String(token));
    const expected = Buffer.from(req.session.csrfToken || '');
    if (!token || supplied.length !== expected.length || !expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      return next(httpError(403, 'Your form has expired. Please try again.'));
    }
    next();
  });

  function requireCustomer(req, res, next) {
    if (req.session.user?.role !== 'customer') {
      req.session.flashMessage = 'Please log in as a customer to continue.';
      return res.redirect('/login');
    }
    next();
  }

  function requireAdmin(req, res, next) {
    if (req.session.user?.role !== 'admin') {
      req.session.flashMessage = 'Administrator access is required.';
      return res.redirect('/login');
    }
    next();
  }

  function route(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  }

  function redirectWithMessage(req, res, location, message) {
    req.session.flashMessage = message;
    res.redirect(location);
  }

  function requireCollections(req, res, next) {
    if (!collections) return next(httpError(503, 'The database is not ready. Please try again shortly.'));
    next();
  }
  app.use(requireCollections);

  app.get('/', (req, res) => res.render('default/home'));
  app.get('/about', (req, res) => res.render('default/about'));
  app.get('/contact', (req, res) => res.render('default/contact'));
  app.get('/registration', (req, res) => res.render('default/registration'));
  app.get('/admin_registration', requireAdmin, (req, res) => res.render('default/admin_registration'));
  app.get('/login', (req, res) => res.render('default/login'));

  async function migratePassword(collection, account, submittedPassword) {
    const storedHash = account.password_hash;
    if (storedHash) return bcrypt.compare(submittedPassword, storedHash);
    if (typeof account.pwd !== 'string' || account.pwd !== submittedPassword) return false;
    const passwordHash = await bcrypt.hash(submittedPassword, BCRYPT_ROUNDS);
    await collection.updateOne({ _id: account._id }, { $set: { password_hash: passwordHash }, $unset: { pwd: '' } });
    return true;
  }

  async function findAccountByEmail(collection, email) {
    const exactMatch = await collection.findOne({ email_id: email });
    if (exactMatch) return exactMatch;
    // Older admin records may have been saved with mixed-case email addresses.
    const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return collection.findOne({ email_id: { $regex: `^${escapedEmail}$`, $options: 'i' } });
  }

  app.post('/log_user', route(async (req, res) => {
    const email = String(req.body.txtemail || '').trim().toLowerCase();
    const password = String(req.body.txtpwd || '');
    if (!email || !password || email.length > 254 || password.length > 200) throw httpError(400, 'Enter a valid email and password.');
    let account = await findAccountByEmail(collections.admins, email);
    let role = 'admin';
    let accountCollection = collections.admins;
    if (!account || !(await migratePassword(accountCollection, account, password))) {
      account = await findAccountByEmail(collections.customers, email);
      role = 'customer';
      accountCollection = collections.customers;
    }
    if (!account || !(await migratePassword(accountCollection, account, password))) throw httpError(401, 'Email or password is incorrect.');
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = role === 'admin'
      ? { role, id: String(account._id), admin_id: account.admin_id, name: account.admin_name, email: account.email_id }
      : { role, id: String(account._id), customer_id: account.customer_id, name: account.customer_name, email: account.email_id };
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
    res.redirect(role === 'admin' ? '/admin_manage_cat' : '/books');
  }));

  app.post('/logout', (req, res, next) => {
    req.session.destroy(error => {
      if (error) return next(error);
      res.clearCookie('bookreselling.sid', { httpOnly: true, sameSite: 'lax', secure: secureCookies === undefined ? 'auto' : secureCookies });
      res.redirect('/');
    });
  });
  app.get('/logout', (req, res) => res.sendStatus(405));

  app.post('/add_customer', route(async (req, res) => {
    const customer = {
      customer_name: validateText(req.body.txtname, 'Name', 100),
      address: validateText(req.body.txtadd, 'Address', 300),
      city: validateText(req.body.txtcity, 'City', 100),
      mobile_no: validateText(req.body.txtmno, 'Mobile number', 30),
      email_id: validateText(req.body.txtemail, 'Email', 254).toLowerCase(),
    };
    if (!/^\S+@\S+\.\S+$/.test(customer.email_id)) throw httpError(400, 'Enter a valid email address.');
    const password = String(req.body.txtpwd || '');
    if (password.length < 8 || password.length > 200 || Buffer.byteLength(password, 'utf8') > 72) throw httpError(400, 'Password must be 8 or more characters and no more than 72 UTF-8 bytes.');
    if (await collections.customers.findOne({ email_id: customer.email_id })) throw httpError(409, 'An account with that email already exists.');
    const last = await collections.customers.find().sort({ customer_id: -1 }).limit(1).toArray();
    customer.customer_id = last.length ? (Number(last[0].customer_id) || 0) + 1 : 1;
    customer.password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await collections.customers.insertOne(customer);
    redirectWithMessage(req, res, '/login', 'Registration successful. Please sign in.');
  }));

  // Admin accounts are provisioned directly in MongoDB or by an existing administrator.
  app.post('/add_admin', requireAdmin, route(async (req, res) => {
    const name = validateText(req.body.txtname, 'Name', 100);
    const email = validateText(req.body.txtemail, 'Email', 254).toLowerCase();
    const password = String(req.body.txtpwd || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password.length > 200 || Buffer.byteLength(password, 'utf8') > 72) throw httpError(400, 'Enter a valid email and a password of at least 12 characters (72 UTF-8 bytes maximum).');
    if (await collections.admins.findOne({ email_id: email })) throw httpError(409, 'An administrator with that email already exists.');
    const last = await collections.admins.find().sort({ admin_id: -1 }).limit(1).toArray();
    await collections.admins.insertOne({ admin_id: last.length ? (Number(last[0].admin_id) || 0) + 1 : 1, admin_name: name, email_id: email, password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS) });
    redirectWithMessage(req, res, '/admin_manage_cat', 'Administrator account created.');
  }));

  app.get('/books', route(async (req, res) => {
    const [categories, books] = await Promise.all([collections.categories.find().toArray(), collections.books.find().toArray()]);
    const booksWithCategory = books.map(book => ({ ...book, category_name: categories.find(item => item.category_id === book.category_id)?.category || 'Unknown' }));
    res.render('default/view_books', { categories, bookitems: booksWithCategory });
  }));

  app.get('/buy_book/:bid', requireCustomer, route(async (req, res) => {
    const bookId = parsePositiveId(req.params.bid);
    if (!bookId) throw httpError(400, 'Invalid book ID.');
    const book = await collections.books.findOne({ book_id: bookId });
    if (!book) throw httpError(404, 'Book not found.');
    const category = await collections.categories.findOne({ category_id: book.category_id });
    req.session.orderToken = crypto.randomBytes(24).toString('hex');
    res.render('default/buy_book', { bookitem: { ...book, category_name: category?.category || 'Unknown' }, orderToken: req.session.orderToken });
  }));

  app.post('/place_order', requireCustomer, route(async (req, res) => {
    const bookId = parsePositiveId(req.body.txtbid);
    const quantity = parsePositiveId(req.body.txtqty);
    if (!bookId) throw httpError(400, 'Choose a valid book.');
    if (!quantity || quantity > 100) throw httpError(400, 'Quantity must be between 1 and 100.');
    const token = String(req.body.orderToken || '');
    if (!token || !req.session.orderToken || token !== req.session.orderToken) throw httpError(409, 'This order form has already been submitted or expired. Please try again.');
    req.session.orderToken = null;
    const [book, customer] = await Promise.all([
      collections.books.findOne({ book_id: bookId }),
      collections.customers.findOne({ customer_id: req.session.user.customer_id }),
    ]);
    if (!book) throw httpError(404, 'Book not found.');
    if (!customer) throw httpError(401, 'Please sign in again to place an order.');
    const price = parsePrice(book.book_price);
    if (price === null) throw httpError(409, 'This book does not have a valid price and cannot be ordered.');
    const category = await collections.categories.findOne({ category_id: book.category_id });
    const last = await collections.orders.find().sort({ order_id: -1 }).limit(1).toArray();
    const orderId = last.length ? (Number(last[0].order_id) || 0) + 1 : 1;
    const totalAmount = Math.round(price * quantity * 100) / 100;
    await collections.orders.insertOne({
      order_id: orderId, customer_id: customer.customer_id, customer_name: customer.customer_name,
      email_id: customer.email_id, address: customer.address, city: customer.city, mobile_no: customer.mobile_no,
      book_id: book.book_id, book_name: book.book_name, category_name: category?.category || 'Unknown',
      book_img: book.book_img, book_price: price, quantity, total_amount: totalAmount,
      order_date: new Date().toLocaleDateString('en-GB'), status: 'Placed',
    });
    redirectWithMessage(req, res, '/my_orders', 'Order placed successfully.');
  }));

  app.get('/my_orders', requireCustomer, route(async (req, res) => {
    const orders = await collections.orders.find({ customer_id: req.session.user.customer_id }).sort({ order_id: -1 }).toArray();
    res.render('default/my_orders', { orderitems: orders });
  }));

  app.get('/admin_manage_cat', requireAdmin, route(async (req, res) => {
    res.render('admin/admin_manage_cat', { layout: 'layouts/adminlayouts', catitems: await collections.categories.find().toArray() });
  }));
  app.post('/add_cat', requireAdmin, route(async (req, res) => {
    const category = validateText(req.body.txtcat, 'Category', 100);
    if (await collections.categories.findOne({ category })) throw httpError(409, 'That category already exists.');
    const last = await collections.categories.find().sort({ category_id: -1 }).limit(1).toArray();
    await collections.categories.insertOne({ category_id: last.length ? (Number(last[0].category_id) || 0) + 1 : 1, category });
    redirectWithMessage(req, res, '/admin_manage_cat', 'Category saved.');
  }));
  app.post('/delete_category/:cid', requireAdmin, route(async (req, res) => {
    const categoryId = parsePositiveId(req.params.cid);
    if (!categoryId) throw httpError(400, 'Invalid category ID.');
    if (await collections.books.findOne({ category_id: categoryId })) throw httpError(409, 'Move or delete books in this category before deleting it.');
    const result = await collections.categories.deleteOne({ category_id: categoryId });
    if (!result.deletedCount) throw httpError(404, 'Category not found.');
    redirectWithMessage(req, res, '/admin_manage_cat', 'Category deleted.');
  }));
  app.get('/delete_category/:cid', (req, res) => res.sendStatus(405));
  app.get('/edit_category/:cid', requireAdmin, route(async (req, res) => {
    const categoryId = parsePositiveId(req.params.cid);
    if (!categoryId) throw httpError(400, 'Invalid category ID.');
    const category = await collections.categories.findOne({ category_id: categoryId });
    if (!category) throw httpError(404, 'Category not found.');
    res.render('admin/admin_update_cat', { layout: 'layouts/adminlayouts', catitems: [category] });
  }));
  app.post('/update_cat', requireAdmin, route(async (req, res) => {
    const categoryId = parsePositiveId(req.body.txtcatid);
    const category = validateText(req.body.txtcat, 'Category', 100);
    if (!categoryId) throw httpError(400, 'Invalid category ID.');
    const result = await collections.categories.updateOne({ category_id: categoryId }, { $set: { category } });
    if (!result.matchedCount) throw httpError(404, 'Category not found.');
    redirectWithMessage(req, res, '/admin_manage_cat', 'Category updated.');
  }));

  app.get('/admin_manage_book', requireAdmin, route(async (req, res) => {
    const [catitems, bookitems] = await Promise.all([collections.categories.find().toArray(), collections.books.find().toArray()]);
    res.render('admin/admin_manage_book', { layout: 'layouts/adminlayouts', catitems, bookitems });
  }));
  app.post('/add_book', requireAdmin, route(async (req, res) => {
    const book_name = validateText(req.body.txtname, 'Book title', 200);
    const description = validateText(req.body.txtdesc, 'Description', 5000, false);
    const category_id = parsePositiveId(req.body.selcat);
    const book_price = parsePrice(req.body.txtprice);
    if (!category_id || !(await collections.categories.findOne({ category_id }))) throw httpError(400, 'Choose a valid category.');
    if (book_price === null) throw httpError(400, 'Enter a price greater than zero with up to two decimal places.');
    const file = req.files?.txtimg;
    if (Array.isArray(file)) throw httpError(400, 'Upload only one book image.');
    const image = getImageInfo(file);
    const fileName = `${crypto.randomUUID()}${image.extension}`;
    const imagePath = path.join(uploadDir, fileName);
    await fs.promises.writeFile(imagePath, file.data, { flag: 'wx' });
    try {
      const last = await collections.books.find().sort({ book_id: -1 }).limit(1).toArray();
      const book_id = last.length ? (Number(last[0].book_id) || 0) + 1 : 1;
      await collections.books.insertOne({ book_id, book_name, category_id, description, book_price, book_img: `/book_img/${fileName}` });
    } catch (error) {
      await fs.promises.unlink(imagePath).catch(() => {});
      throw error;
    }
    redirectWithMessage(req, res, '/admin_manage_book', 'Book saved.');
  }));
  app.post('/delete_book/:bid', requireAdmin, route(async (req, res) => {
    const bookId = parsePositiveId(req.params.bid);
    if (!bookId) throw httpError(400, 'Invalid book ID.');
    const result = await collections.books.deleteOne({ book_id: bookId });
    if (!result.deletedCount) throw httpError(404, 'Book not found.');
    redirectWithMessage(req, res, '/admin_manage_book', 'Book deleted.');
  }));
  app.get('/delete_book/:bid', (req, res) => res.sendStatus(405));
  app.get('/edit_book/:bid', requireAdmin, route(async (req, res) => {
    const bookId = parsePositiveId(req.params.bid);
    if (!bookId) throw httpError(400, 'Invalid book ID.');
    const [categoryItems, book] = await Promise.all([collections.categories.find().toArray(), collections.books.findOne({ book_id: bookId })]);
    if (!book) throw httpError(404, 'Book not found.');
    res.render('admin/admin_update_book', { layout: 'layouts/adminlayouts', catitems: categoryItems, bookitems: [book] });
  }));
  app.post('/update_book', requireAdmin, route(async (req, res) => {
    const bookId = parsePositiveId(req.body.txtbid);
    const book_name = validateText(req.body.txtname, 'Book title', 200);
    const description = validateText(req.body.txtdesc, 'Description', 5000, false);
    const category_id = parsePositiveId(req.body.selcat);
    const book_price = parsePrice(req.body.txtprice);
    if (!bookId) throw httpError(400, 'Invalid book ID.');
    if (!category_id || !(await collections.categories.findOne({ category_id }))) throw httpError(400, 'Choose a valid category.');
    if (book_price === null) throw httpError(400, 'Enter a price greater than zero with up to two decimal places.');
    const update = { book_name, category_id, description, book_price };
    const file = req.files?.txtimg;
    let imagePath;
    if (file) {
      if (Array.isArray(file)) throw httpError(400, 'Upload only one book image.');
      const image = getImageInfo(file);
      const fileName = `${crypto.randomUUID()}${image.extension}`;
      imagePath = path.join(uploadDir, fileName);
      await fs.promises.writeFile(imagePath, file.data, { flag: 'wx' });
      update.book_img = `/book_img/${fileName}`;
    }
    try {
      const result = await collections.books.updateOne({ book_id: bookId }, { $set: update });
      if (!result.matchedCount) throw httpError(404, 'Book not found.');
    } catch (error) {
      if (imagePath) await fs.promises.unlink(imagePath).catch(() => {});
      throw error;
    }
    redirectWithMessage(req, res, '/admin_manage_book', 'Book updated.');
  }));

  app.get('/admin_reports', requireAdmin, route(async (req, res) => {
    const [categories, books, customers, orders] = await Promise.all([
      collections.categories.find().toArray(), collections.books.find().toArray(), collections.customers.find().project({ pwd: 0, password_hash: 0 }).toArray(), collections.orders.find().toArray(),
    ]);
    const booksWithCategory = books.map(book => ({ ...book, category_name: categories.find(item => item.category_id === book.category_id)?.category || 'Unknown' }));
    res.render('admin/admin_reports', { layout: 'layouts/adminlayouts', totalCategories: categories.length, totalBooks: books.length, totalCustomers: customers.length, totalOrders: orders.length, reportBooks: booksWithCategory, reportCustomers: customers, reportOrders: orders });
  }));
  app.get('/admin_orders', requireAdmin, route(async (req, res) => {
    const orderitems = await collections.orders.find().sort({ order_id: -1 }).toArray();
    res.render('admin/admin_orders', { layout: 'layouts/adminlayouts', orderitems });
  }));
  app.get('/admin_bill/:oid', requireAdmin, route(async (req, res) => {
    const orderId = parsePositiveId(req.params.oid);
    if (!orderId) throw httpError(400, 'Invalid order ID.');
    const orderitem = await collections.orders.findOne({ order_id: orderId });
    if (!orderitem) throw httpError(404, 'Order not found.');
    res.render('admin/admin_bill', { layout: 'layouts/adminlayouts', orderitem });
  }));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = Number.isInteger(err.status) ? err.status : 500;
    if (status >= 500) console.error('Request failed:', safeErrorDetail(err));
    if (req.accepts('html')) {
      req.session.flashMessage = status >= 500 ? 'Something went wrong. Please try again.' : err.message;
      let returnPath = '/';
      try {
        const candidate = new URL(req.get('referer') || '/', 'http://bookreselling.local');
        if (candidate.pathname.startsWith('/') && !candidate.pathname.startsWith('//')) returnPath = candidate.pathname + candidate.search;
      } catch (_) {}
      return res.redirect(status === 401 || status === 403 ? '/login' : returnPath);
    }
    res.status(status).send(status >= 500 ? 'Something went wrong. Please try again.' : err.message);
  });
  return app;
}

function createMongoSessionStore(client, dbName) {
  return MongoStore.create({ client, dbName, collectionName: 'sessions', ttl: 60 * 60 * 8, autoRemove: 'native' });
}

let mongoClient;
let readyPromise;
let activeApp;
async function initialize() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
      throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
    }
    if (process.env.NODE_ENV === 'production' && !process.env.MONGODB_URI) throw new Error('MONGODB_URI is required in production.');
    const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
    const dbName = process.env.MONGODB_DB_NAME || 'book_reselling';
    mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: Number(process.env.MONGODB_CONNECT_TIMEOUT_MS) || 10000 });
    await mongoClient.connect();
    const db = mongoClient.db(dbName);
    const collections = {
      admins: db.collection('admin_detail'), customers: db.collection('customer_details'), categories: db.collection('category_master'),
      books: db.collection('book_detail'), orders: db.collection('order_detail'),
    };
    activeApp = createApp({
      collections, sessionStore: createMongoSessionStore(mongoClient, dbName), sessionSecret: process.env.SESSION_SECRET,
      trustProxy: process.env.TRUST_PROXY === '1' ? 1 : false,
    });
    console.log('Database connected successfully');
    return activeApp;
  })();
  return readyPromise;
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  initialize().then(serverApp => serverApp.listen(port, () => console.log(`Server started on port ${port}`))).catch(error => {
    console.error('Application startup failed:', safeErrorDetail(error));
    process.exitCode = 1;
  });
}

async function vercelHandler(req, res) {
  try {
    const serverApp = await initialize();
    return serverApp(req, res);
  } catch (error) {
    console.error('Application startup failed:', safeErrorDetail(error));
    if (!res.headersSent) res.status(503).send('Service temporarily unavailable.');
  }
}

module.exports = activeApp || vercelHandler;
module.exports.createApp = createApp;
module.exports.parsePositiveId = parsePositiveId;
module.exports.parsePrice = parsePrice;
module.exports.getImageInfo = getImageInfo;
module.exports.safeErrorDetail = safeErrorDetail;
module.exports.initialize = initialize;
