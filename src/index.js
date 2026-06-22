const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const { MongoClient, ObjectId, ServerApiVersion } = require('mongodb');

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || 'sk_test_missing');
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

app.use(
  cors({
    origin: [process.env.CLIENT_URL || 'http://localhost:3000'],
    credentials: true,
  })
);
app.use(express.json({ limit: '10mb' }));

let db;
const id = (value) => new ObjectId(value);
const cleanUser = (user) => {
  if (!user) return null;
  const { password, ...safe } = user;
  return { ...safe, _id: user._id.toString() };
};
const tokenFor = (user) =>
  jwt.sign(
    { id: user._id.toString(), email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Unauthorized' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await db.collection('Donor').findOne({ _id: id(decoded.id) });
    if (!user) return res.status(401).json({ message: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ message: 'Unauthorized' });
  }
}

const allow =
  (...roles) =>
  (req, res, next) =>
    roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ message: 'Forbidden' });

app.get('/', (req, res) => res.json({ ok: true, name: 'BloodLink API' }));

pp.post('/api/auth/register', async (req, res) => {
  const {
    email,
    password,
    confirm_password,
    name,
    avatar,
    bloodGroup,
    district,
    upazila,
  } = req.body;
  if (!email || !password || !name || !bloodGroup || !district || !upazila) {
    return res.status(400).json({ message: 'Missing required fields' });
  }
  if (password !== confirm_password)
    return res.status(400).json({ message: 'Passwords do not match' });
  const exists = await db
    .collection('Donor')
    .findOne({ email: email.toLowerCase() });
  if (exists)
    return res.status(409).json({ message: 'Email already registered' });
  const user = {
    email: email.toLowerCase(),
    password: await bcrypt.hash(password, 10),
    name,
    avatar,
    bloodGroup,
    district,
    upazila,
    role: 'donor',
    status: 'active',
    createdAt: new Date(),
  };
  const result = await db.collection('Donor').insertOne(user);
  user._id = result.insertedId;
  res.status(201).json({ user: cleanUser(user), token: tokenFor(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await db
    .collection('Donor')
    .findOne({ email: String(email || '').toLowerCase() });
  if (!user || !(await bcrypt.compare(password || '', user.password))) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }
  res.json({ user: cleanUser(user), token: tokenFor(user) });
});

app.get('/api/auth/me', auth, (req, res) => res.json(cleanUser(req.user)));

app.patch('/api/users/me', auth, async (req, res) => {
  const allowed = ['name', 'avatar', 'bloodGroup', 'district', 'upazila'];
  const update = {};
  allowed.forEach((key) => {
    if (req.body[key] !== undefined) update[key] = req.body[key];
  });
  await db
    .collection('Donor')
    .updateOne(
      { _id: req.user._id },
      { $set: { ...update, updatedAt: new Date() } }
    );
  const user = await db.collection('Donor').findOne({ _id: req.user._id });
  res.json(cleanUser(user));
});

app.get('/api/users', auth, allow('admin'), async (req, res) => {
  const query = req.query.status ? { status: req.query.status } : {};
  const users = await db
    .collection('Donor')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.json(users.map(cleanUser));
});

app.patch(
  '/api/users/:userId/status',
  auth,
  allow('admin'),
  async (req, res) => {
    if (!['active', 'blocked'].includes(req.body.status))
      return res.status(400).json({ message: 'Invalid status' });
    await db
      .collection('Donor')
      .updateOne(
        { _id: id(req.params.userId) },
        { $set: { status: req.body.status } }
      );
    res.json({ modified: true });
  }
);

app.patch('/api/users/:userId/role', auth, allow('admin'), async (req, res) => {
  if (!['donor', 'volunteer', 'admin'].includes(req.body.role))
    return res.status(400).json({ message: 'Invalid role' });
  await db
    .collection('Donor')
    .updateOne(
      { _id: id(req.params.userId) },
      { $set: { role: req.body.role } }
    );
  res.json({ modified: true });
});

app.get('/api/donors/search', async (req, res) => {
  const { bloodGroup, district, upazila } = req.query;
  if (!bloodGroup || !district || !upazila) return res.json([]);
  const users = await db
    .collection('Donor')
    .find({ role: 'donor', status: 'active', bloodGroup, district, upazila })
    .toArray();
  res.json(users.map(cleanUser));
});

app.get('/api/requests', async (req, res) => {
  const requests = await db
    .collection('donationRequests')
    .find({ status: 'pending' })
    .sort({ createdAt: -1 })
    .toArray();
  res.json(requests);
});

app.post('/api/requests', auth, async (req, res) => {
  if (req.user.status === 'blocked')
    return res
      .status(403)
      .json({ message: 'Blocked users cannot create requests' });
  const request = {
    requesterId: req.user._id.toString(),
    requesterName: req.user.name,
    requesterEmail: req.user.email,
    recipientName: req.body.recipientName,
    recipientDistrict: req.body.recipientDistrict,
    recipientUpazila: req.body.recipientUpazila,
    hospitalName: req.body.hospitalName,
    address: req.body.address,
    bloodGroup: req.body.bloodGroup,
    donationDate: req.body.donationDate,
    donationTime: req.body.donationTime,
    message: req.body.message,
    status: 'pending',
    createdAt: new Date(),
  };
  const result = await db.collection('donationRequests').insertOne(request);
  res.status(201).json({ ...request, _id: result.insertedId });
});

app.get('/api/requests/my', auth, async (req, res) => {
  const query = { requesterId: req.user._id.toString() };
  if (req.query.status) query.status = req.query.status;
  const rows = await db
    .collection('donationRequests')
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();
  res.json(rows);
});

app.get(
  '/api/requests/all',
  auth,
  allow('admin', 'volunteer'),
  async (req, res) => {
    const query = req.query.status ? { status: req.query.status } : {};
    const rows = await db
      .collection('donationRequests')
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();
    res.json(rows);
  }
);

app.get('/api/requests/:requestId', auth, async (req, res) => {
  const request = await db
    .collection('donationRequests')
    .findOne({ _id: id(req.params.requestId) });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  res.json(request);
});

app.patch('/api/requests/:requestId', auth, async (req, res) => {
  const request = await db
    .collection('donationRequests')
    .findOne({ _id: id(req.params.requestId) });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  const owner = request.requesterId === req.user._id.toString();
  const canEditAll = req.user.role === 'admin';
  const volunteerStatusOnly = req.user.role === 'volunteer';
  if (!owner && !canEditAll && !volunteerStatusOnly)
    return res.status(403).json({ message: 'Forbidden' });
  const writable = [
    'recipientName',
    'recipientDistrict',
    'recipientUpazila',
    'hospitalName',
    'address',
    'bloodGroup',
    'donationDate',
    'donationTime',
    'message',
  ];
  const update = {};
  if (!volunteerStatusOnly)
    writable.forEach(
      (key) => req.body[key] !== undefined && (update[key] = req.body[key])
    );
  if (
    req.body.status &&
    ['pending', 'inprogress', 'done', 'canceled'].includes(req.body.status)
  )
    update.status = req.body.status;
  await db
    .collection('donationRequests')
    .updateOne(
      { _id: request._id },
      { $set: { ...update, updatedAt: new Date() } }
    );
  res.json({ modified: true });
});

app.post('/api/requests/:requestId/respond', auth, async (req, res) => {
  const result = await db.collection('donationRequests').updateOne(
    { _id: id(req.params.requestId), status: 'pending' },
    {
      $set: {
        status: 'inprogress',
        donorName: req.user.name,
        donorEmail: req.user.email,
        donorId: req.user._id.toString(),
        updatedAt: new Date(),
      },
    }
  );
  if (!result.modifiedCount)
    return res.status(400).json({ message: 'Request is not pending' });
  res.json({ modified: true });
});

app.delete('/api/requests/:requestId', auth, async (req, res) => {
  const request = await db
    .collection('donationRequests')
    .findOne({ _id: id(req.params.requestId) });
  if (!request) return res.status(404).json({ message: 'Request not found' });
  if (
    req.user.role !== 'admin' &&
    request.requesterId !== req.user._id.toString()
  )
    return res.status(403).json({ message: 'Forbidden' });
  await db.collection('donationRequests').deleteOne({ _id: request._id });
  res.json({ deleted: true });
});

app.get('/api/funds', auth, async (req, res) => {
  const funds = await db
    .collection('funds')
    .find()
    .sort({ createdAt: -1 })
    .toArray();
  res.json(funds);
});

app.post('/api/create-checkout-session', auth, async (req, res) => {
  const amount = Math.round(Number(req.body.amount || 0) * 100);
  if (amount < 100)
    return res.status(400).json({ message: 'Minimum funding amount is 1' });
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:3000';
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    customer_email: req.user.email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: 'BloodLink Organization Fund',
            description: 'Support emergency blood donation operations',
          },
        },
      },
    ],
    success_url: `${clientUrl}/funding?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${clientUrl}/funding?payment=cancelled`,
    metadata: {
      userId: req.user._id.toString(),
      name: req.user.name,
      email: req.user.email,
      amount: String(Number(req.body.amount || 0)),
    },
  });
  res.json({ url: session.url });
});

app.post('/api/checkout-session/:sessionId/confirm', auth, async (req, res) => {
  const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
  if (session.payment_status !== 'paid')
    return res.status(400).json({ message: 'Payment is not completed' });
  if (session.metadata?.userId !== req.user._id.toString())
    return res.status(403).json({ message: 'Forbidden' });
  const existing = await db
    .collection('funds')
    .findOne({ checkoutSessionId: session.id });
  if (existing) return res.json(existing);
  const fund = {
    userId: req.user._id.toString(),
    name: req.user.name,
    email: req.user.email,
    amount: Number(session.metadata?.amount || session.amount_total / 100),
    checkoutSessionId: session.id,
    paymentIntentId: session.payment_intent,
    createdAt: new Date(),
  };
  const result = await db.collection('funds').insertOne(fund);
  res.status(201).json({ ...fund, _id: result.insertedId });
});

app.get('/api/stats', auth, allow('admin', 'volunteer'), async (req, res) => {
  const [totalUsers, totalRequests, funds, recentUsers] = await Promise.all([
    db.collection('Donor').countDocuments({ role: 'donor' }),
    db.collection('donationRequests').countDocuments(),
    db
      .collection('funds')
      .aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
      .toArray(),
    db.collection('Donor').find().sort({ createdAt: -1 }).limit(5).toArray(),
  ]);
  res.json({
    totalUsers,
    totalRequests,
    totalFunding: funds[0]?.total || 0,
    recentUsers: recentUsers.map(cleanUser),
  });
});

async function start() {
  await client.connect();
  db = client.db(process.env.DB_NAME || 'Blood');
  await db.collection('Donor').createIndex({ email: 1 }, { unique: true });
  app.listen(port, () => console.log(`BloodLink API running on ${port}`));
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
