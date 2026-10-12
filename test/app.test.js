const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const session = require('express-session');
const { createApp } = require('../index');

class MemoryCollection {
  constructor(rows = []) { this.rows = rows; this.failFind = false; }
  matches(row, filter = {}) { return Object.entries(filter).every(([key, value]) => row[key] === value); }
  async findOne(filter) { if (this.failFind) throw new Error('database unavailable'); return this.rows.find(row => this.matches(row, filter)) || null; }
  find(filter = {}) {
    const collection = this;
    let rows = this.rows.filter(row => collection.matches(row, filter));
    let projection;
    const cursor = {
      sort(spec) { const [[key, direction]] = Object.entries(spec); rows = [...rows].sort((a, b) => direction < 0 ? (b[key] || 0) - (a[key] || 0) : (a[key] || 0) - (b[key] || 0)); return cursor; },
      limit(count) { rows = rows.slice(0, count); return cursor; },
      project(spec) { projection = spec; return cursor; },
      async toArray() {
        if (collection.failFind) throw new Error('database unavailable');
        return rows.map(row => {
          const copy = { ...row };
          for (const [key, include] of Object.entries(projection || {})) if (include === 0) delete copy[key];
          return copy;
        });
      },
    };
    return cursor;
  }
  async insertOne(row) { this.rows.push({ ...row, _id: row._id || `${this.rows.length + 1}` }); return { insertedId: this.rows.at(-1)._id }; }
  async updateOne(filter, update) {
    const row = this.rows.find(item => this.matches(item, filter));
    if (!row) return { matchedCount: 0, modifiedCount: 0 };
    Object.assign(row, update.$set || {});
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    return { matchedCount: 1, modifiedCount: 1 };
  }
  async deleteOne(filter) {
    const index = this.rows.findIndex(row => this.matches(row, filter));
    if (index < 0) return { deletedCount: 0 };
    this.rows.splice(index, 1);
    return { deletedCount: 1 };
  }
  async createIndex() { return 'test-index'; }
}

function fixture() {
  const collections = {
    admins: new MemoryCollection([{ _id: 'a1', admin_id: 1, admin_name: 'Admin', email_id: 'admin@example.test', password_hash: bcrypt.hashSync('AdminPassword123!', 4) }]),
    customers: new MemoryCollection([
      { _id: 'c1', customer_id: 1, customer_name: 'One', address: 'A', city: 'X', mobile_no: '1', email_id: 'one@example.test', pwd: 'CustomerOne123!' },
      { _id: 'c2', customer_id: 2, customer_name: 'Two', address: 'B', city: 'Y', mobile_no: '2', email_id: 'two@example.test', password_hash: bcrypt.hashSync('CustomerTwo123!', 4) },
    ]),
    categories: new MemoryCollection([{ category_id: 1, category: 'Fiction' }]),
    books: new MemoryCollection([{ book_id: 1, book_name: 'Sample Book', category_id: 1, description: 'A sample', book_price: 12.5, book_img: '/book_img/sample.jpg' }]),
    orders: new MemoryCollection([
      { order_id: 1, customer_id: 1, book_name: 'One customer order', quantity: 1, total_amount: 12.5 },
      { order_id: 2, customer_id: 2, book_name: 'Other customer order', quantity: 1, total_amount: 12.5 },
    ]),
  };
  const app = createApp({ collections, sessionStore: new session.MemoryStore(), sessionSecret: 'test-only-secret-long-enough-for-tests', secureCookies: false });
  return { app, collections };
}

async function csrf(agent, path = '/login') {
  const response = await agent.get(path);
  const match = response.text.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, `CSRF token rendered at ${path}`);
  return match[1];
}

async function login(agent, email, password) {
  const token = await csrf(agent);
  return agent.post('/log_user').type('form').send({ _csrf: token, txtemail: email, txtpwd: password });
}

test('legacy plaintext password is migrated only after a successful login', async () => {
  const { app, collections } = fixture();
  const response = await login(request.agent(app), 'one@example.test', 'CustomerOne123!');
  assert.equal(response.status, 302);
  assert.equal(response.headers.location, '/books');
  const customer = collections.customers.rows[0];
  assert.match(customer.password_hash, /^\$2[aby]\$/);
  assert.equal(Object.hasOwn(customer, 'pwd'), false);
});

test('customer registration stores only a bcrypt password hash', async () => {
  const { app, collections } = fixture();
  const visitor = request.agent(app);
  const token = await csrf(visitor, '/registration');
  const response = await visitor.post('/add_customer').type('form').send({
    _csrf: token, txtname: 'New Customer', txtadd: '12 Main Street', txtcity: 'Town', txtmno: '555-1234',
    txtemail: 'new@example.test', txtpwd: 'NewCustomer123!',
  });
  assert.equal(response.status, 302);
  const created = collections.customers.rows.find(row => row.email_id === 'new@example.test');
  assert.match(created.password_hash, /^\$2[aby]\$/);
  assert.equal(Object.hasOwn(created, 'pwd'), false);
  assert.equal(await bcrypt.compare('NewCustomer123!', created.password_hash), true);
});

test('separate customer agents keep independent identities and order histories', async () => {
  const { app } = fixture();
  const first = request.agent(app);
  const second = request.agent(app);
  await login(first, 'one@example.test', 'CustomerOne123!');
  await login(second, 'two@example.test', 'CustomerTwo123!');
  const firstOrders = await first.get('/my_orders');
  const secondOrders = await second.get('/my_orders');
  assert.equal(firstOrders.status, 200);
  assert.match(firstOrders.text, /One customer order/);
  assert.doesNotMatch(firstOrders.text, /Other customer order/);
  assert.match(secondOrders.text, /Other customer order/);
  assert.doesNotMatch(secondOrders.text, /One customer order/);
});

test('successful login regenerates the session identifier', async () => {
  const { app } = fixture();
  const visitor = request.agent(app);
  const loginPage = await visitor.get('/login');
  const before = loginPage.headers['set-cookie'][0].split(';')[0];
  const token = loginPage.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const response = await visitor.post('/log_user').type('form').send({ _csrf: token, txtemail: 'two@example.test', txtpwd: 'CustomerTwo123!' });
  const after = response.headers['set-cookie'].find(value => value.startsWith('bookreselling.sid=')).split(';')[0];
  assert.notEqual(after, before);
  assert.match(response.headers['set-cookie'].join(';'), /HttpOnly/i);
});

test('logout destroys only its own session and cannot access customer routes afterward', async () => {
  const { app } = fixture();
  const first = request.agent(app);
  const second = request.agent(app);
  await login(first, 'one@example.test', 'CustomerOne123!');
  await login(second, 'two@example.test', 'CustomerTwo123!');
  const token = await csrf(first, '/my_orders');
  const logout = await first.post('/logout').type('form').send({ _csrf: token });
  assert.equal(logout.status, 302);
  assert.equal((await first.get('/my_orders')).status, 302);
  assert.equal((await second.get('/my_orders')).status, 200);
});

test('customer cannot open administrator pages or create administrator accounts', async () => {
  const { app, collections } = fixture();
  const customer = request.agent(app);
  await login(customer, 'one@example.test', 'CustomerOne123!');
  assert.equal((await customer.get('/admin_manage_cat')).status, 302);
  assert.equal((await customer.get('/admin_registration')).status, 302);
  const token = await csrf(customer, '/my_orders');
  assert.equal((await customer.post('/add_admin').type('form').send({ _csrf: token, txtname: 'Intruder', txtemail: 'x@example.test', txtpwd: 'Password123456' })).status, 302);
  assert.equal(collections.admins.rows.length, 1);
});

test('a request without a valid CSRF token cannot mutate customer data', async () => {
  const { app, collections } = fixture();
  const response = await request(app).post('/add_customer').set('Accept', 'application/json').type('form').send({ txtname: 'New', txtemail: 'new@example.test' });
  assert.equal(response.status, 403);
  assert.equal(collections.customers.rows.length, 2);
});

test('invalid book/category values and invalid image content are rejected', async () => {
  const { app, collections } = fixture();
  const admin = request.agent(app);
  await login(admin, 'admin@example.test', 'AdminPassword123!');
  let token = await csrf(admin, '/admin_manage_book');
  const invalidFields = await admin.post('/add_book').set('Accept', 'application/json').field('_csrf', token).field('txtname', 'Bad').field('txtdesc', '').field('selcat', '999').field('txtprice', '-5').attach('txtimg', Buffer.from('not an image'), 'bad.jpg');
  assert.equal(invalidFields.status, 400);
  token = await csrf(admin, '/admin_manage_book');
  const invalidPrice = await admin.post('/add_book').set('Accept', 'application/json').field('_csrf', token).field('txtname', 'Bad').field('txtdesc', '').field('selcat', '1').field('txtprice', '-5').attach('txtimg', Buffer.from('not an image'), 'bad.jpg');
  assert.equal(invalidPrice.status, 400);
  token = await csrf(admin, '/admin_manage_book');
  const invalidImage = await admin.post('/add_book').set('Accept', 'application/json').field('_csrf', token).field('txtname', 'Bad').field('txtdesc', '').field('selcat', '1').field('txtprice', '5').attach('txtimg', Buffer.from('not an image'), 'bad.jpg');
  assert.equal(invalidImage.status, 400);
  assert.equal(collections.books.rows.length, 1);
});

test('empty category names and malformed customer registration are rejected', async () => {
  const { app, collections } = fixture();
  const admin = request.agent(app);
  await login(admin, 'admin@example.test', 'AdminPassword123!');
  const adminToken = await csrf(admin, '/admin_manage_cat');
  const badCategory = await admin.post('/add_cat').set('Accept', 'application/json').type('form').send({ _csrf: adminToken, txtcat: ' ' });
  assert.equal(badCategory.status, 400);
  assert.equal(collections.categories.rows.length, 1);

  const visitor = request.agent(app);
  const visitorToken = await csrf(visitor, '/registration');
  const badRegistration = await visitor.post('/add_customer').set('Accept', 'application/json').type('form').send({ _csrf: visitorToken, txtname: '', txtemail: 'not-an-email', txtpwd: 'short' });
  assert.equal(badRegistration.status, 400);
  assert.equal(collections.customers.rows.length, 2);
});

test('order totals use the database price and invalid quantities are rejected', async () => {
  const { app, collections } = fixture();
  const customer = request.agent(app);
  await login(customer, 'one@example.test', 'CustomerOne123!');
  let page = await customer.get('/buy_book/1');
  const token = page.text.match(/name="_csrf" value="([^"]+)"/)[1];
  const orderToken = page.text.match(/name="orderToken" value="([^"]+)"/)[1];
  const response = await customer.post('/place_order').type('form').send({ _csrf: token, txtbid: '1', txtqty: '3', book_price: '0.01', total_amount: '0.01', orderToken });
  assert.equal(response.status, 302);
  const placed = collections.orders.rows.find(order => order.order_id === 3);
  assert.equal(placed.book_price, 12.5);
  assert.equal(placed.total_amount, 37.5);
  const duplicate = await customer.post('/place_order').set('Accept', 'application/json').type('form').send({ _csrf: token, txtbid: '1', txtqty: '3', orderToken });
  assert.equal(duplicate.status, 409);
  page = await customer.get('/buy_book/1');
  const invalid = await customer.post('/place_order').set('Accept', 'application/json').type('form').send({ _csrf: token, txtbid: '1', txtqty: '0', orderToken: page.text.match(/name="orderToken" value="([^"]+)"/)[1] });
  assert.equal(invalid.status, 400);
  assert.equal(collections.orders.rows.length, 3);
});

test('old destructive GET URLs do not mutate books or categories', async () => {
  const { app, collections } = fixture();
  const admin = request.agent(app);
  await login(admin, 'admin@example.test', 'AdminPassword123!');
  assert.equal((await admin.get('/delete_book/1')).status, 405);
  assert.equal((await admin.get('/delete_category/1')).status, 405);
  assert.equal(collections.books.rows.length, 1);
  assert.equal(collections.categories.rows.length, 1);
});

test('database errors return a generic response without leaking driver details', async () => {
  const { app, collections } = fixture();
  const customer = request.agent(app);
  await login(customer, 'one@example.test', 'CustomerOne123!');
  collections.orders.failFind = true;
  const response = await customer.get('/my_orders').set('Accept', 'application/json');
  assert.equal(response.status, 500);
  assert.match(response.text, /Something went wrong/);
  assert.doesNotMatch(response.text, /database unavailable|MONGODB_URI|password/i);
});

test('existing public and administrator EJS pages still render', async () => {
  const { app } = fixture();
  const visitor = request.agent(app);
  for (const page of ['/', '/about', '/contact', '/registration', '/login', '/books']) {
    const response = await visitor.get(page);
    assert.equal(response.status, 200, `${page} should render`);
  }
  const admin = request.agent(app);
  await login(admin, 'admin@example.test', 'AdminPassword123!');
  for (const page of ['/admin_manage_cat', '/admin_manage_book', '/admin_reports', '/admin_orders', '/admin_bill/1', '/edit_category/1', '/edit_book/1', '/admin_registration']) {
    const response = await admin.get(page);
    assert.equal(response.status, 200, `${page} should render`);
  }
});
